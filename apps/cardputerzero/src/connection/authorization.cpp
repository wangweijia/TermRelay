#include "authorization.h"
#include "listing_protocol.h"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <regex>
#include <stdexcept>
#include <thread>
#include <deque>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace connection {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
using Curl = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
constexpr std::size_t max_document = 16384;
constexpr std::size_t max_local_document = 64 * 1024;
constexpr std::size_t max_socket_document = 128 * 1024;
constexpr auto heartbeat_interval = 25s;
constexpr auto heartbeat_timeout = 75s;
std::string utc_timestamp() {
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm utc{};
    std::array<char, 32> output{};
    if (!gmtime_r(&now, &utc) || !std::strftime(output.data(), output.size(), "%Y-%m-%dT%H:%M:%SZ", &utc)) {
        throw std::runtime_error("Cannot read system time");
    }
    return output.data();
}
void initialize_curl() {
    static const bool initialized = [] { if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) throw std::runtime_error("Network initialization failed"); return true; }();
    (void)initialized;
}
std::string random_id() {
    std::array<unsigned char, 16> bytes{};
    std::ifstream random("/dev/urandom", std::ios::binary);
    if (!random.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) throw std::runtime_error("Secure random unavailable");
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) result += '-';
        result += hex[bytes[index] >> 4]; result += hex[bytes[index] & 15];
    }
    return result;
}
std::string decode_base64(const std::string& input) {
    if (input.size() > 32768 || input.size() % 4) throw std::runtime_error("Invalid event chunk encoding");
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output; unsigned value = 0; int bits = -8; bool padding = false;
    for (const char byte : input) {
        if (byte == '=') { padding = true; continue; }
        const auto digit = alphabet.find(byte);
        if (padding || digit == std::string::npos) throw std::runtime_error("Invalid event chunk encoding");
        value = (value << 6) | static_cast<unsigned>(digit); bits += 6;
        if (bits >= 0) { output += static_cast<char>((value >> bits) & 255); bits -= 8; }
    }
    return output;
}
bool valid_credential(const std::string& value) {
    static const std::regex pattern("^tr_controller_[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$");
    return std::regex_match(value, pattern);
}
struct Stored {
    std::string installation_id = random_id();
    std::string origin;
    std::string credential;
    Json pending_commands = Json::array();
};
class Store {
public:
    explicit Store(std::string directory) : directory_(std::move(directory)) {
        if (!directory_.is_absolute()) throw std::runtime_error("State directory must be absolute");
        std::filesystem::create_directories(directory_);
        struct stat info{};
        if (lstat(directory_.c_str(), &info) || !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || chmod(directory_.c_str(), 0700)) throw std::runtime_error("Unsafe state directory");
    }
    Stored load() {
        const auto path = directory_ / "authorization.json";
        const int descriptor = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (descriptor < 0) {
            if (errno == ENOENT) { Stored value; save(value); return value; }
            throw std::runtime_error("Cannot read local authorization");
        }
        struct stat info{};
        const bool safe = fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == geteuid() && !(info.st_mode & 0077) && info.st_size > 0 && info.st_size <= static_cast<off_t>(max_local_document);
        if (!safe) { close(descriptor); throw std::runtime_error("Unsafe local authorization file"); }
        std::string content(static_cast<std::size_t>(info.st_size), '\0');
        std::size_t offset = 0;
        while (offset < content.size()) {
            const auto count = read(descriptor, content.data() + offset, content.size() - offset);
            if (count <= 0) { close(descriptor); throw std::runtime_error("Cannot read local authorization"); }
            offset += static_cast<std::size_t>(count);
        }
        close(descriptor);
        try {
            const auto document = Json::parse(content);
            Stored result;
            result.installation_id = document.at("installationId").get<std::string>();
            result.origin = document.at("origin").get<std::string>();
            result.credential = document.at("credential").get<std::string>();
            result.pending_commands = document.value("pendingCommands", Json::array());
            if (!result.pending_commands.is_array() || result.pending_commands.size() > 32) throw std::runtime_error("invalid receipts");
            for (const auto& receipt : result.pending_commands) {
                if (!receipt.is_object() || receipt.size() != 3 || !receipt.at("commandId").is_string() || receipt.at("commandId").get_ref<const std::string&>().size() != 36
                    || !receipt.at("sessionId").is_string() || receipt.at("sessionId").get_ref<const std::string&>().size() > 512
                    || !receipt.at("type").is_string()) throw std::runtime_error("invalid receipt");
            }
            if (document.at("version") != 1 || result.installation_id.empty() || result.installation_id.size() > 128 || (!result.credential.empty() && (!valid_credential(result.credential) || result.origin.empty()))) throw std::runtime_error("invalid document");
            return result;
        } catch (...) { throw std::runtime_error("Invalid local authorization file"); }
    }
    void save(const Stored& value) {
        const auto content = Json{{"version", 1}, {"installationId", value.installation_id}, {"origin", value.origin}, {"credential", value.credential}, {"pendingCommands", value.pending_commands}}.dump();
        std::string temporary = (directory_ / ".authorization-XXXXXX").string();
        const int descriptor = mkstemp(temporary.data());
        if (descriptor < 0) throw std::runtime_error("Cannot save local authorization");
        bool success = fchmod(descriptor, 0600) == 0;
        std::size_t offset = 0;
        while (success && offset < content.size()) {
            const auto count = write(descriptor, content.data() + offset, content.size() - offset);
            if (count <= 0) { success = false; break; }
            offset += static_cast<std::size_t>(count);
        }
        success = (fsync(descriptor) == 0) && success;
        success = (close(descriptor) == 0) && success;
        if (!success || rename(temporary.c_str(), (directory_ / "authorization.json").c_str())) {
            unlink(temporary.c_str()); throw std::runtime_error("Cannot save local authorization");
        }
        const int parent = open(directory_.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (parent >= 0) { fsync(parent); close(parent); }
    }
private:
    std::filesystem::path directory_;
};
}

std::string normalize_origin(const std::string& input, bool allow_test_loopback) {
    initialize_curl();
    if (input.empty() || input.size() > 2048) throw std::runtime_error("Enter the server domain");
    const auto candidate = input.find("://") == std::string::npos ? "https://" + input : input;
    std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> url(curl_url(), curl_url_cleanup);
    if (!url || curl_url_set(url.get(), CURLUPART_URL, candidate.c_str(), 0) != CURLUE_OK) throw std::runtime_error("Invalid server address");
    const auto part = [&](CURLUPart key) -> std::optional<std::string> {
        char* value = nullptr;
        if (curl_url_get(url.get(), key, &value, CURLU_NO_DEFAULT_PORT) != CURLUE_OK) return std::nullopt;
        std::string result(value); curl_free(value); return result;
    };
    const auto scheme = part(CURLUPART_SCHEME).value_or("");
    const auto host = part(CURLUPART_HOST).value_or("");
    const auto path = part(CURLUPART_PATH).value_or("");
    if (scheme != "https" && !(allow_test_loopback && scheme == "http" && (host == "127.0.0.1" || host == "[::1]"))) throw std::runtime_error("HTTPS is required");
    if (host.empty() || part(CURLUPART_USER) || part(CURLUPART_PASSWORD) || part(CURLUPART_QUERY) || part(CURLUPART_FRAGMENT) || (path != "/" && !path.empty())) throw std::runtime_error("Use a server domain without a path");
    const auto port = part(CURLUPART_PORT);
    return scheme + "://" + host + (port ? ":" + *port : "");
}
std::string default_state_directory() {
    if (const char* state = std::getenv("XDG_STATE_HOME"); state && std::filesystem::path(state).is_absolute()) return (std::filesystem::path(state) / "termrelay-cardputerzero").string();
    if (const char* home = std::getenv("HOME"); home && std::filesystem::path(home).is_absolute()) return (std::filesystem::path(home) / ".local/state/termrelay-cardputerzero").string();
    throw std::runtime_error("Set HOME or XDG_STATE_HOME");
}

class Authorization::Impl {
public:
    Impl(std::string directory, bool allow_test_loopback) : store_(std::move(directory)), stored_(store_.load()), allow_loopback_(allow_test_loopback) {
        initialize_curl();
        if (!stored_.origin.empty()) stored_.origin = normalize_origin(stored_.origin, allow_loopback_);
        snapshot_.origin = stored_.origin;
        snapshot_.has_credential = !stored_.credential.empty();
        receipts_ = stored_.pending_commands;
        if (!stored_.credential.empty()) command_ = stored_.origin;
        worker_ = std::thread([this] { run(); });
    }
    ~Impl() { stopped_ = true; cancelled_ = true; condition_.notify_all(); if (worker_.joinable()) worker_.join(); }
    Snapshot snapshot() const { std::lock_guard lock(mutex_); return snapshot_; }
    ListingSnapshot listing() const { std::lock_guard lock(mutex_); return listing_; }
    void list(const std::string& device_id, const std::string& cursor) {
        std::lock_guard lock(mutex_);
        if (snapshot_.state != State::Connected || !listing_.supported || device_id.size() > 512 || cursor.size() > 512) return;
        last_query_ = {device_id, cursor, ++query_version_};
        queued_query_ = last_query_;
        listing_.loading = true; listing_.error.clear();
    }
    ConversationSnapshot conversation() const { std::lock_guard lock(mutex_); return conversation_.state; }
    void open_conversation(const std::string& id) {
        std::lock_guard lock(mutex_);
        if (id.empty() || id.size() > 512) return;
        if (snapshot_.state != State::Connected || !conversation_.state.supported) {
            if (conversation_.state.session_id != id) conversation_.state.error = "Connect to open this conversation";
            return;
        }
        conversation_open_ = true; ++conversation_generation_; cancel_queued_rpcs(); conversation_.open(id); restore_receipt(id);
        queue_rpc("sync");
    }
    void close_conversation() {
        std::lock_guard lock(mutex_);
        conversation_open_ = false; cancel_queued_rpcs();
        if (!conversation_.state.session_id.empty() && snapshot_.state == State::Connected) queue_rpc("close");
        ++conversation_generation_; conversation_.state.ready = false;
    }
    void acknowledge_unknown_command() {
        std::lock_guard lock(mutex_);
        if (conversation_.state.command_state == "unknown") { conversation_.state.command_state = "idle"; conversation_.state.revision++; }
    }
    void conversation_read(const std::string& op, const Json& arguments) {
        std::lock_guard lock(mutex_);
        if (snapshot_.state != State::Connected || !conversation_.state.supported || conversation_.state.session_id.empty()) return;
        if (op == "sync") { ++conversation_generation_; cancel_queued_rpcs(); conversation_.state.loading = true; queue_rpc(op); }
        else if (op == "history" || op == "requests" || op == "event" || op == "status") {
            if (op != "status" && conversation_.state.sync_id.empty()) return;
            if (op == "event") { event_bytes_.clear(); event_seq_ = arguments.at("seq").get<std::uint64_t>(); }
            queue_rpc(op, arguments);
        }
    }
    std::string conversation_command(const std::string& type, const Json& data, const std::string& review_token) {
        std::lock_guard lock(mutex_);
        if (snapshot_.state != State::Connected || receipts_.size() >= 32 || rpc_queries_.size() >= 4 || data.dump().size() > 48 * 1024) return "";
        if (type != "tool.turn.start" && type != "tool.turn.interrupt" && type != "tool.approval.resolve" && type != "tool.user-input.resolve") return "";
        const auto id = random_id();
        try { conversation_.begin_command(id, type); }
        catch (const std::exception& error) { conversation_.state.error = error.what(); return ""; }
        Json args{{"commandId", id}, {"type", type}, {"data", data}};
        if (!review_token.empty()) args["reviewToken"] = review_token;
        queue_rpc("command", args); return id;
    }
    void connect(const std::string& origin) {
        std::lock_guard lock(mutex_);
        if (active_ || command_) return;
        command_ = origin; cancelled_ = false; condition_.notify_all();
    }
    void cancel() { cancelled_ = true; condition_.notify_all(); }
    void forget() { std::lock_guard lock(mutex_); forget_ = true; cancelled_ = true; condition_.notify_all(); }

private:
    struct Query {
        std::string device_id, cursor; std::uint64_t version = 0;
        std::string op; Json payload = Json::object(); std::uint64_t generation = 0;
    };
    void cancel_queued_rpcs() {
        for (const auto& query : rpc_queries_) if (query.op == "command" && query.payload.at("commandId") == conversation_.state.command_id)
            conversation_.state.command_state = "not_sent";
        rpc_queries_.clear();
    }
    void restore_receipt(const std::string& id) {
        for (const auto& receipt : receipts_) if (receipt.at("sessionId") == id) {
            conversation_.state.command_id = receipt.at("commandId"); conversation_.state.command_type = receipt.at("type");
            conversation_.state.command_state = "unknown";
        }
    }
    void queue_rpc(const std::string& op, Json args = Json::object()) {
        if (rpc_queries_.size() >= 4) { conversation_.fail(op, "Request queue is full; retry after checking status"); return; }
        if (op == "requests" && std::any_of(rpc_queries_.begin(), rpc_queries_.end(), [](const Query& item) { return item.op == "requests"; })) return;
        args["op"] = op; args["sessionId"] = conversation_.state.session_id;
        if (op != "sync" && op != "status" && op != "close") args["syncId"] = conversation_.state.sync_id;
        Query query; query.op = op; query.payload = std::move(args); query.generation = conversation_generation_;
        rpc_queries_.push_back(std::move(query));
    }
    void retire_receipt(const Json& response) {
        const auto& body = response.at("body");
        if (!body.contains("ack") || !body.at("ack").is_object() || body.at("ack").value("status", "") != "completed") return;
        const auto id = body.value("commandId", "");
        if (body.at("ack").value("commandId", "") != id) return;
        stored_.pending_commands.erase(std::remove_if(stored_.pending_commands.begin(), stored_.pending_commands.end(), [&](const Json& item) {
            return item.at("commandId") == id && item.at("sessionId") == response.at("sessionId");
        }), stored_.pending_commands.end());
        store_.save(stored_);
        std::lock_guard lock(mutex_); receipts_ = stored_.pending_commands;
    }
    void clear_listing() {
        std::lock_guard lock(mutex_);
        listing_ = {}; last_query_ = {}; queued_query_.reset(); ++query_version_;
        conversation_ = {}; rpc_queries_.clear(); receipts_ = Json::array(); event_bytes_.clear(); ++conversation_generation_;
    }
    void query_error(const Query& query, const std::string& message) {
        std::lock_guard lock(mutex_);
        if (!query.op.empty()) {
            if (query.generation == conversation_generation_) conversation_.fail(query.op, message);
            return;
        }
        if (query.version != query_version_) return;
        listing_.loading = false; listing_.error = message; listing_.revision++;
    }
    void publish(State state, std::string message = "", unsigned devices = 0) {
        std::lock_guard lock(mutex_);
        if (state != State::Connected) { listing_.loading = false; conversation_.disconnected(); }
        snapshot_ = { state, stored_.origin, std::move(message), devices, !stored_.credential.empty() };
    }
    bool wait(std::chrono::milliseconds delay) {
        std::unique_lock lock(mutex_);
        return condition_.wait_for(lock, delay, [this] { return stopped_.load() || cancelled_.load(); });
    }
    void configure(CURL* handle, const std::string& url) {
        curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
        curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
        curl_easy_setopt(handle, CURLOPT_TIMEOUT_MS, 10000L);
        curl_easy_setopt(handle, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(handle, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(handle, CURLOPT_SSL_VERIFYHOST, 2L);
        curl_easy_setopt(handle, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(handle, CURLOPT_XFERINFODATA, &stopped_);
        curl_easy_setopt(handle, CURLOPT_XFERINFOFUNCTION, +[](void* context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int { return static_cast<const std::atomic<bool>*>(context)->load() ? 1 : 0; });
    }
    std::optional<Json> post(const std::string& path, const Json& body) {
        Curl handle(curl_easy_init(), curl_easy_cleanup);
        if (!handle) throw std::runtime_error("Network initialization failed");
        configure(handle.get(), stored_.origin + path);
        std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(curl_slist_append(nullptr, "Content-Type: application/json"), curl_slist_free_all);
        const auto serialized = body.dump();
        std::string response;
        curl_easy_setopt(handle.get(), CURLOPT_HTTPHEADER, headers.get());
        curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDS, serialized.c_str());
        curl_easy_setopt(handle.get(), CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(handle.get(), CURLOPT_WRITEFUNCTION, +[](char* data, std::size_t size, std::size_t count, void* context) -> std::size_t {
            auto& output = *static_cast<std::string*>(context);
            const auto length = size * count;
            if (length > max_document || output.size() > max_document - length) return 0;
            output.append(data, length); return length;
        });
        const auto result = curl_easy_perform(handle.get());
        long status = 0; curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
        if (result != CURLE_OK || status >= 500) return std::nullopt;
        if (status < 200 || status >= 300) throw std::runtime_error("Authorization rejected; check server access");
        auto document = Json::parse(response, nullptr, false);
        if (!document.is_object()) throw std::runtime_error("Invalid server response");
        return document;
    }
    void pairing() {
        publish(State::Starting);
        const auto created = post("/api/client-pairings", {{"role", "controller"}, {"installationId", stored_.installation_id}, {"deviceName", "CardputerZero"}, {"appVersion", "0.1.0"}});
        if (!created) throw std::runtime_error("Cannot reach server; retry connection");
        const auto id = created->at("pairingId").get<std::string>();
        const auto code = created->at("deviceCode").get<std::string>();
        if (created->at("role") != "controller" || id.empty() || code.empty()) throw std::runtime_error("Invalid pairing response");
        const auto lifetime = std::chrono::seconds(std::clamp(created->at("expiresIn").get<int>(), 1, 600));
        const auto interval = std::chrono::seconds(std::clamp(created->at("pollInterval").get<int>(), 3, 30));
        const auto deadline = Clock::now() + lifetime;
        Json request{{"role", "controller"}, {"pairingId", id}, {"deviceCode", code}};
        publish(State::Waiting, "Approve in Web > Settings");
        while (!stopped_ && Clock::now() < deadline) {
            if (cancelled_) {
                request["action"] = "cancel";
                const auto cancelled = post("/api/client-pairings/token", request);
                publish(State::Idle, cancelled ? "" : "Cancel not confirmed; request will expire"); return;
            }
            const auto response = post("/api/client-pairings/token", request);
            if (!response) { publish(State::Waiting, "Network unavailable; retrying"); wait(interval); continue; }
            const auto status = response->at("status").get<std::string>();
            if (status == "issued") {
                const auto credential = response->at("credential").get<std::string>();
                if (response->at("role") != "controller" || !response->at("expiresAt").is_null() || !valid_credential(credential)) throw std::runtime_error("Invalid controller credential");
                stored_.credential = credential; store_.save(stored_);
                if (cancelled_) { publish(State::Idle); return; }
                return;
            }
            if (status == "access_denied") { publish(State::Denied, "Authorization denied"); return; }
            if (status == "expired_token") { publish(State::Expired, "Request expired; connect again"); return; }
            if (status != "authorization_pending") throw std::runtime_error("Request is no longer available");
            publish(State::Waiting, "Approve in Web > Settings"); wait(interval);
        }
        if (!stopped_) publish(State::Expired, "Request expired; connect again");
    }
    void revoked() {
        stored_.credential.clear(); stored_.pending_commands = Json::array(); store_.save(stored_);
        clear_listing();
        publish(State::Revoked, "Authorization removed in Web");
    }
    void socket_loop() {
        unsigned attempt = 0;
        while (!stopped_ && !cancelled_) {
            publish(attempt ? State::Retrying : State::Connecting, attempt ? "Connection lost; retrying" : "");
            Curl handle(curl_easy_init(), curl_easy_cleanup);
            if (!handle) throw std::runtime_error("Network initialization failed");
            const auto url = (stored_.origin.rfind("https:", 0) == 0 ? "wss:" + stored_.origin.substr(6) : "ws:" + stored_.origin.substr(5)) + "/ws/client-public";
            configure(handle.get(), url);
            const auto header = "Authorization: Bearer " + stored_.credential;
            std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers(curl_slist_append(nullptr, header.c_str()), curl_slist_free_all);
            curl_easy_setopt(handle.get(), CURLOPT_HTTPHEADER, headers.get());
            curl_easy_setopt(handle.get(), CURLOPT_CONNECT_ONLY, 2L);
            const auto opened = curl_easy_perform(handle.get());
            long status = 0; curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
            if (status == 401) { revoked(); return; }
            if (opened == CURLE_UNSUPPORTED_PROTOCOL || opened == CURLE_NOT_BUILT_IN) throw std::runtime_error("libcurl requires WebSocket support");
            if (status == 403 || (status >= 300 && status < 400)) throw std::runtime_error("Check public WebSocket Access bypass");
            if (opened == CURLE_OK && status == 101) {
                const auto handshake_deadline = Clock::now() + 10s;
                auto last_confirmed = Clock::now();
                auto next_heartbeat = Clock::now() + heartbeat_interval;
                bool confirmed = false;
                std::string frame;
                std::string outgoing;
                std::size_t outgoing_offset = 0;
                bool outgoing_heartbeat = false;
                std::optional<Query> pending_query;
                std::string pending_id;
                auto query_deadline = Clock::now();
                bool listing_supported = false;
                std::vector<std::string> authorized_devices;
                while (!stopped_ && !cancelled_) {
                    const auto now = Clock::now();
                    if ((!confirmed && now >= handshake_deadline) || (confirmed && now - last_confirmed >= heartbeat_timeout)) break;
                    if (pending_query && now >= query_deadline) {
                        query_error(*pending_query, "List request timed out; refresh to retry");
                        pending_query.reset(); pending_id.clear();
                    }
                    if (confirmed && outgoing.empty() && now >= next_heartbeat) {
                        outgoing = Json{{"event", "message"}, {"data", {
                            {"type", "controller.me.get"}, {"protocolVersion", "2"},
                            {"messageId", random_id()}, {"deviceId", stored_.installation_id},
                            {"sentAt", utc_timestamp()}, {"payload", Json::object()},
                        }}}.dump();
                        outgoing_offset = 0;
                        outgoing_heartbeat = true;
                    }
                    if (confirmed && listing_supported && outgoing.empty() && !pending_query) {
                        {
                            std::lock_guard lock(mutex_);
                            if (!rpc_queries_.empty()) { pending_query = rpc_queries_.front(); rpc_queries_.pop_front(); }
                            else if (queued_query_) { pending_query = *queued_query_; queued_query_.reset(); }
                        }
                        if (pending_query) {
                            pending_id = random_id();
                            Json payload{{"limit", 20}};
                            if (!pending_query->device_id.empty()) payload["deviceId"] = pending_query->device_id;
                            if (!pending_query->cursor.empty()) payload["cursor"] = pending_query->cursor;
                            if (!pending_query->op.empty()) payload = pending_query->payload;
                            if (pending_query->op == "command") {
                                const Json receipt{{"commandId", payload.at("commandId")}, {"sessionId", payload.at("sessionId")}, {"type", payload.at("type")}};
                                stored_.pending_commands.push_back(receipt); store_.save(stored_);
                                std::lock_guard lock(mutex_); receipts_ = stored_.pending_commands;
                            }
                            outgoing = Json{{"event", "message"}, {"data", {
                                {"type", !pending_query->op.empty() ? "controller.conversation" : pending_query->device_id.empty() ? "controller.devices.list" : "controller.sessions.list"},
                                {"protocolVersion", "2"}, {"messageId", pending_id}, {"deviceId", stored_.installation_id},
                                {"sentAt", utc_timestamp()}, {"payload", payload},
                            }}}.dump();
                            outgoing_offset = 0; query_deadline = now + 10s;
                            outgoing_heartbeat = false;
                        }
                    }
                    if (!outgoing.empty()) {
                        std::size_t sent = 0;
                        const auto result = curl_ws_send(handle.get(), outgoing.data() + outgoing_offset,
                            outgoing.size() - outgoing_offset, &sent, 0, CURLWS_TEXT);
                        if (result != CURLE_OK && result != CURLE_AGAIN) break;
                        if (result == CURLE_OK) outgoing_offset += sent;
                        if (outgoing_offset == outgoing.size()) {
                            outgoing.clear();
                            if (outgoing_heartbeat) next_heartbeat = Clock::now() + heartbeat_interval;
                        }
                    }
                    std::array<char, 4096> buffer{};
                    std::size_t count = 0;
                    const curl_ws_frame* metadata = nullptr;
                    const auto received = curl_ws_recv(handle.get(), buffer.data(), buffer.size(), &count, &metadata);
                    if (received == CURLE_AGAIN) {
                        wait(30ms); continue;
                    }
                    if (received != CURLE_OK || !metadata) break;
                    if (metadata->flags & CURLWS_CLOSE) {
                        if (count >= 2 && ((static_cast<unsigned char>(buffer[0]) << 8) | static_cast<unsigned char>(buffer[1])) == 4003) { revoked(); return; }
                        break;
                    }
                    if (metadata->flags & (CURLWS_PING | CURLWS_PONG)) continue;
                    if (!(metadata->flags & (CURLWS_TEXT | CURLWS_CONT))) throw std::runtime_error("Invalid controller frame");
                    if (frame.size() + count > max_socket_document) throw std::runtime_error("Controller frame too large");
                    frame.append(buffer.data(), count);
                    if (metadata->bytesleft || (metadata->flags & CURLWS_CONT)) continue;
                    const auto message = Json::parse(frame, nullptr, false); frame.clear();
                    if (!message.is_object() || message.value("protocolVersion", "") != "2" || message.value("deviceId", "") != stored_.installation_id) throw std::runtime_error("Invalid controller handshake");
                    const auto type = message.value("type", "");
                    if (type == "controller.authorization-revoked") { revoked(); return; }
                    if (type == "controller.connected") {
                        const auto& payload = message.at("payload");
                        if (payload.at("role") != "controller" || payload.at("installationId") != stored_.installation_id || !payload.at("expiresAt").is_null() || !payload.at("deviceIds").is_array() || payload.at("deviceIds").size() > 100) throw std::runtime_error("Invalid controller handshake");
                        authorized_devices.clear();
                        for (const auto& id : payload.at("deviceIds")) {
                            if (!id.is_string() || id.get_ref<const std::string&>().empty() || id.get_ref<const std::string&>().size() > 512)
                                throw std::runtime_error("Invalid authorized device");
                            authorized_devices.push_back(id.get<std::string>());
                        }
                        const auto capabilities = payload.value("capabilities", Json::array());
                        listing_supported = capabilities.is_array()
                            && std::find(capabilities.begin(), capabilities.end(), "devices.list") != capabilities.end()
                            && std::find(capabilities.begin(), capabilities.end(), "sessions.list") != capabilities.end();
                        if (!confirmed) {
                            std::lock_guard lock(mutex_);
                            listing_.supported = listing_supported;
                            conversation_.state.supported = std::find(capabilities.begin(), capabilities.end(), "conversation") != capabilities.end();
                            if (conversation_open_ && conversation_.state.supported && !conversation_.state.session_id.empty()) {
                                cancel_queued_rpcs(); ++conversation_generation_; queue_rpc("sync");
                            }
                            if (listing_supported) {
                                last_query_.version = ++query_version_;
                                queued_query_ = last_query_; listing_.loading = true; listing_.error.clear();
                            } else { listing_.loading = false; listing_.error = "Upgrade Server to browse sessions"; listing_.revision++; }
                        }
                        // libcurl consumes server PINGs automatically. Only a validated
                        // application response proves that the controller is still usable.
                        last_confirmed = Clock::now();
                        if (!confirmed) next_heartbeat = last_confirmed + heartbeat_interval;
                        confirmed = true; attempt = 0;
                        publish(State::Connected, "Authorized", static_cast<unsigned>(payload.at("deviceIds").size()));
                    } else if (confirmed && type == "controller.conversation.result") {
                        const auto& response = message.at("payload");
                        const auto op = response.value("op", "");
                        const bool correlated = pending_query && !pending_query->op.empty()
                            && response.value("relatedMessageId", "") == pending_id;
                        if (op == "ack" || op == "status") retire_receipt(response);
                        {
                            std::lock_guard lock(mutex_);
                            if (correlated && pending_query->generation != conversation_generation_) {
                                // A switched-away session must not install its old snapshot.
                            } else if (op == "event" && correlated) {
                                const auto& body = response.at("body");
                                if (body.at("seq") != event_seq_ || body.at("offset") != event_bytes_.size()
                                    || body.at("total").get<std::size_t>() > 256 * 1024) throw std::runtime_error("Large content requires Web");
                                event_bytes_ += decode_base64(body.at("data").get<std::string>());
                                if (event_bytes_.size() > body.at("total").get<std::size_t>()) throw std::runtime_error("Invalid event chunk");
                                if (body.at("final").get<bool>()) {
                                    if (event_bytes_.size() != body.at("total").get<std::size_t>()) throw std::runtime_error("Incomplete event content");
                                    const auto loaded = Json::parse(event_bytes_);
                                    if (loaded.at("seq") != event_seq_) throw std::runtime_error("Wrong loaded event");
                                    conversation_.loaded(loaded, body.value("reviewToken", ""), event_bytes_.size()); event_bytes_.clear();
                                } else queue_rpc("event", {{"seq", event_seq_}, {"offset", event_bytes_.size()}});
                            } else if (correlated || op == "events" || op == "ack" || op == "resync") {
                                try { conversation_.apply(response); }
                                catch (const std::exception& error) { conversation_.fail(op, error.what()); }
                                if (correlated && op == "sync") { queue_rpc("ready"); queue_rpc("requests"); }
                                if (correlated && op == "ready" && conversation_.state.command_state == "unknown")
                                    queue_rpc("status", {{"commandId", conversation_.state.command_id}});
                                if (conversation_.state.requests_changed && conversation_.state.ready) queue_rpc("requests");
                                if (conversation_.state.needs_sync && !conversation_.state.sync_id.empty()) {
                                    ++conversation_generation_; cancel_queued_rpcs(); conversation_.state.sync_id.clear(); queue_rpc("sync");
                                }
                            }
                        }
                        if (correlated) { pending_query.reset(); pending_id.clear(); }
                    } else if (confirmed && pending_query && message.at("payload").value("relatedMessageId", "") == pending_id) {
                        const auto query = *pending_query;
                        if (type == "protocol.error") {
                            query_error(query, "Request unavailable; refresh or check status / Web authorization");
                        } else if (type == (query.device_id.empty() ? "controller.devices.listed" : "controller.sessions.listed")) {
                            std::lock_guard lock(mutex_);
                            if (query.version == query_version_) {
                                auto next = listing_;
                                apply_listing_page(next, message.at("payload"), query.device_id, query.cursor);
                                if (query.device_id.empty()) {
                                    for (const auto& device : next.devices)
                                        if (std::find(authorized_devices.begin(), authorized_devices.end(), device.id) == authorized_devices.end())
                                            throw std::runtime_error("Unexpected list device");
                                } else if (std::find(authorized_devices.begin(), authorized_devices.end(), query.device_id) == authorized_devices.end()) {
                                    throw std::runtime_error("Unexpected session device");
                                }
                                listing_ = std::move(next);
                            }
                        } else { throw std::runtime_error("Invalid list response type"); }
                        pending_query.reset(); pending_id.clear();
                    }
                }
            }
            if (stopped_ || cancelled_) break;
            { std::lock_guard lock(mutex_); listing_.loading = false; }
            ++attempt;
            publish(State::Retrying, "Connection lost; retrying");
            const auto jitter = static_cast<unsigned char>(random_id().back()) % 500;
            wait(std::chrono::milliseconds(std::min(30000u, 1000u << std::min(attempt - 1, 5u)) + jitter));
        }
        if (!stopped_) publish(State::Idle);
        { std::lock_guard lock(mutex_); listing_.loading = false; }
    }
    void run() {
        while (!stopped_) {
            std::string requested;
            bool forgetting = false;
            {
                std::unique_lock lock(mutex_);
                condition_.wait(lock, [this] { return stopped_.load() || forget_ || command_.has_value(); });
                if (stopped_) break;
                forgetting = forget_; forget_ = false;
                if (command_) { requested = std::move(*command_); command_.reset(); }
                active_ = true;
            }
            try {
                if (forgetting) {
                    clear_listing();
                    stored_.credential.clear(); stored_.pending_commands = Json::array(); store_.save(stored_); publish(State::Idle, "Local key cleared; Web grant unchanged");
                } else if (cancelled_) {
                    publish(State::Idle);
                } else {
                    const auto origin = normalize_origin(requested, allow_loopback_);
                    if (!stored_.credential.empty() && origin != stored_.origin) throw std::runtime_error("Clear local key before changing server");
                    if (stored_.origin != origin) clear_listing();
                    stored_.origin = origin; store_.save(stored_);
                    if (stored_.credential.empty()) pairing();
                    if (!stored_.credential.empty() && !cancelled_) socket_loop();
                }
            } catch (const nlohmann::json::exception&) { publish(State::Error, "Invalid server response"); }
            catch (const std::exception& error) { publish(State::Error, error.what()); }
            { std::lock_guard lock(mutex_); active_ = false; }
        }
    }
    Store store_;
    Stored stored_;
    bool allow_loopback_;
    mutable std::mutex mutex_;
    std::condition_variable condition_;
    Snapshot snapshot_;
    ConversationModel conversation_;
    bool conversation_open_ = false;
    Json receipts_ = Json::array();
    std::deque<Query> rpc_queries_;
    std::uint64_t conversation_generation_ = 0, event_seq_ = 0;
    std::string event_bytes_;
    ListingSnapshot listing_;
    Query last_query_;
    std::optional<Query> queued_query_;
    std::uint64_t query_version_ = 0;
    std::optional<std::string> command_;
    bool active_ = false;
    bool forget_ = false;
    std::atomic<bool> stopped_{false};
    std::atomic<bool> cancelled_{false};
    std::thread worker_;
};

Authorization::Authorization(std::string directory, bool allow_test_loopback) : impl_(std::make_unique<Impl>(std::move(directory), allow_test_loopback)) {}
Authorization::~Authorization() = default;
void Authorization::connect(const std::string& origin) { impl_->connect(origin); }
void Authorization::cancel() { impl_->cancel(); }
void Authorization::forget() { impl_->forget(); }
Snapshot Authorization::snapshot() const { return impl_->snapshot(); }
ListingSnapshot Authorization::listing() const { return impl_->listing(); }
ConversationSnapshot Authorization::conversation() const { return impl_->conversation(); }
void Authorization::open_conversation(const std::string& id) { impl_->open_conversation(id); }
void Authorization::close_conversation() { impl_->close_conversation(); }
void Authorization::acknowledge_unknown_command() { impl_->acknowledge_unknown_command(); }
void Authorization::conversation_read(const std::string& op, const Json& arguments) { impl_->conversation_read(op, arguments); }
std::string Authorization::conversation_command(const std::string& type, const Json& data, const std::string& token) { return impl_->conversation_command(type, data, token); }
void Authorization::list_devices(const std::string& cursor) { impl_->list("", cursor); }
void Authorization::list_sessions(const std::string& device_id, const std::string& cursor) { impl_->list(device_id, cursor); }
}
