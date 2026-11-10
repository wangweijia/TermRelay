#include "conversation.h"
#include "listing_protocol.h"
#include <algorithm>
#include <set>
#include <stdexcept>

namespace connection {
namespace {
using Json = nlohmann::json;
constexpr std::uint64_t max_seq = 9007199254740991ULL;
void human_payload(const Json& payload) {
    if (!payload.is_object() || !payload.contains("kind") || !payload.at("kind").is_string()) return;
    const auto kind = payload.at("kind").get<std::string>();
    if (kind != "approval.requested" && kind != "user-input.requested") return;
    const auto& data = payload.at("data");
    const auto string_field = [](const Json& object, const char* key) {
        if (!object.contains(key) || !object.at(key).is_string() || object.at(key).get_ref<const std::string&>().empty())
            throw std::runtime_error("Invalid human request");
    };
    string_field(data, "turnId");
    string_field(data, kind == "approval.requested" ? "approvalId" : "requestId");
    if (data.contains("expiresAt") && !data.at("expiresAt").is_string()) throw std::runtime_error("Invalid request expiry");
    if (kind == "approval.requested") return;
    const auto& questions = data.at("questions");
    if (!questions.is_array() || questions.empty()) throw std::runtime_error("Invalid questions");
    std::set<std::string> ids;
    for (const auto& question : questions) {
        string_field(question, "id"); string_field(question, "question");
        if (!ids.insert(question.at("id").get<std::string>()).second) throw std::runtime_error("Duplicate question");
        for (const auto* flag : {"allowsMultiple", "allowsOther", "isSecret"})
            if (question.contains(flag) && !question.at(flag).is_boolean()) throw std::runtime_error("Invalid question flag");
        if (question.contains("options")) {
            if (!question.at("options").is_array()) throw std::runtime_error("Invalid question options");
            for (const auto& option : question.at("options")) string_field(option, "label");
        }
    }
}
std::uint64_t number(const Json& value) {
    if (!value.is_number_unsigned() && !value.is_number_integer()) throw std::runtime_error("Invalid conversation sequence");
    const auto result = value.get<std::int64_t>();
    if (result < 0 || static_cast<std::uint64_t>(result) > max_seq) throw std::runtime_error("Invalid conversation sequence");
    return static_cast<std::uint64_t>(result);
}
void page(const Json& items) {
    if (!items.is_array() || items.size() > 20 || items.dump().size() > 100 * 1024) throw std::runtime_error("Invalid conversation page");
    std::set<std::uint64_t> ids;
    for (const auto& item : items) {
        const auto seq = number(item.at("seq")); number(item.at("bytes"));
        if (!ids.insert(seq).second || !item.at("type").is_string() || !item.at("createdAt").is_string()
            || (!item.at("payload").is_object() && !item.at("payload").is_null())) throw std::runtime_error("Invalid conversation event");
        if (!item.at("payload").is_null() && item.at("payload").dump().size() > 32 * 1024) throw std::runtime_error("Inline event too large");
        human_payload(item.at("payload"));
    }
}
std::string str(const Json& object, const char* key) {
    auto it = object.find(key); return it != object.end() && it->is_string() ? it->get<std::string>() : "";
}
std::int64_t before(const Json& body) {
    return body.at("beforeSeq").is_null() ? -1 : static_cast<std::int64_t>(number(body.at("beforeSeq")));
}
}
void ConversationModel::open(const std::string& id) {
    const auto supported = state.supported;
    state = {}; state.supported = supported; state.session_id = id; state.loading = true; state.needs_sync = true; state.revision++;
}
void ConversationModel::disconnected() {
    state.ready = false; state.loading = false;
    if (state.command_state == "waiting") state.command_state = "unknown";
    state.revision++;
}
void ConversationModel::begin_command(const std::string& id, const std::string& type) {
    if (!state.ready || !state.can_write || state.command_state == "waiting" || state.command_state == "unknown")
        throw std::runtime_error("Check the previous command result first");
    state.command_id = id; state.command_type = type; state.command_state = "waiting"; state.error.clear(); state.revision++;
}
void ConversationModel::fail(const std::string& op, const std::string& message) {
    state.loading = false; state.error = message;
    if (op == "command") state.command_state = "unknown";
    if (op == "sync" || op == "ready") state.ready = false;
    state.revision++;
}
void ConversationModel::merge(const Json& events, bool live, bool older) {
    page(events);
    auto sorted = events;
    std::sort(sorted.begin(), sorted.end(), [](const Json& a, const Json& b) { return number(a.at("seq")) < number(b.at("seq")); });
    for (const auto& event : sorted) {
        const auto seq = number(event.at("seq"));
        if (live) {
            if (seq <= state.through_seq) continue;
            if (seq != state.through_seq + 1) { state.needs_sync = true; state.ready = false; throw std::runtime_error("Conversation gap; resynchronizing"); }
            state.through_seq = seq;
        }
        auto existing = std::find_if(state.events.begin(), state.events.end(), [&](const Json& item) { return item.at("seq") == seq; });
        if (existing == state.events.end()) { state.events.push_back(event); project(event); }
    }
    std::sort(state.events.begin(), state.events.end(), [](const Json& a, const Json& b) { return number(a.at("seq")) < number(b.at("seq")); });
    while (state.events.size() > 128 || state.events.dump().size() > 256 * 1024) {
        if (older) state.events.erase(std::prev(state.events.end()));
        else state.events.erase(state.events.begin());
    }
    if (older) { state.messages.clear(); for (const auto& event : state.events) project(event); }
    std::sort(state.messages.begin(), state.messages.end(), [](const ChatMessage& a, const ChatMessage& b) { return a.seq < b.seq; });
    while (state.messages.size() > 64) {
        if (older) state.messages.pop_back(); else state.messages.erase(state.messages.begin());
    }
    std::size_t size = 0; for (const auto& message : state.messages) size += message.text.size();
    while (size > 256 * 1024 && state.messages.size() > 1) {
        if (older) { size -= state.messages.back().text.size(); state.messages.pop_back(); }
        else { size -= state.messages.front().text.size(); state.messages.erase(state.messages.begin()); }
    }
}
void ConversationModel::project(const Json& event) {
    const auto seq = number(event.at("seq")); const auto& payload = event.at("payload");
    if (payload.is_null()) {
        state.messages.push_back({"large:" + std::to_string(seq), "Large event", "Content not loaded. Open details to load, or use Web for content over 256 KiB.", seq, true}); return;
    }
    if (event.at("type") != "tool.event") return;
    const auto kind = str(payload, "kind"); const auto data = payload.value("data", Json::object());
    if (kind == "reasoning.delta" || kind == "command.output") return;
    const auto correlation = payload.value("correlation", Json::object());
    const auto identity = str(correlation, "itemId"); const auto turn = str(correlation, "turnId");
    const auto id = (kind == "assistant.delta" || kind == "assistant.completed")
        ? "assistant:" + turn + ":" + identity : kind + ":" + std::to_string(seq);
    const auto content = str(data, "text");
    auto existing = std::find_if(state.messages.begin(), state.messages.end(), [&](const ChatMessage& message) { return message.id == id; });
    if (kind == "assistant.delta" || kind == "assistant.completed") {
        if (existing == state.messages.end()) { state.messages.push_back({id, "Agent", "", seq, false}); existing = std::prev(state.messages.end()); }
        if (kind == "assistant.completed" && !content.empty()) { existing->text = content; existing->incomplete = false; }
        else if (!existing->incomplete) existing->text += content;
        if (existing->text.size() > 64 * 1024) {
            std::size_t cut = 64 * 1024; while (cut && (static_cast<unsigned char>(existing->text[cut]) & 0xc0) == 0x80) --cut;
            existing->text.resize(cut); existing->text += "\n[Display limit reached; view complete answer in Web]"; existing->incomplete = true;
        }
    } else if (kind == "user.message") state.messages.push_back({id, "You", content, seq, false});
    else if (kind == "approval.requested" || kind == "user-input.requested") state.messages.push_back({id, "Needs your response", str(data, "title"), seq, false});
    else if (kind == "error" || kind == "warning") state.messages.push_back({id, kind, str(data, "message"), seq, false});
    else if (kind == "turn.completed") state.messages.push_back({id, "Turn complete", str(data, "status"), seq, false});
}
void ConversationModel::apply(const Json& response) {
    auto next = *this;
    try { next.apply_response(response); *this = std::move(next); }
    catch (...) { if (next.state.needs_sync) { state.needs_sync = true; state.ready = false; } throw; }
}
void ConversationModel::apply_response(const Json& response) {
    if (str(response, "sessionId") != state.session_id) return;
    const auto op = str(response, "op"); const auto& body = response.at("body");
    if (!body.is_object()) throw std::runtime_error("Invalid conversation response");
    if (op == "resync") { state.ready = false; state.needs_sync = true; state.error = "Resynchronizing after a history gap"; state.revision++; return; }
    if (op == "ack" || op == "status") {
        if (str(body, "commandId") != state.command_id || body.at("ack").is_null()) return;
        const auto& ack = body.at("ack");
        if (str(ack, "commandId") != state.command_id || state.command_state == "confirmed") return;
        const auto status = str(ack, "status");
        if (status == "completed") { state.command_state = "confirmed"; state.error.clear(); }
        else if (status == "failed" || status == "rejected") { state.command_state = "unknown"; state.error = "Command result is uncertain. Check status before sending again."; }
        state.revision++; return;
    }
    if (op == "command" || op == "close") return;
    if (op != "sync" && str(body, "syncId") != state.sync_id) return;
    if (op == "sync" || op == "events") {
        const auto& session = body.at("session"); ListingSnapshot checked;
        apply_listing_page(checked, Json{{"relatedMessageId", "checked"}, {"deviceId", session.at("deviceId")}, {"items", Json::array({session})}, {"nextCursor", nullptr}}, session.at("deviceId").get<std::string>(), "");
        if (checked.sessions[0].id != state.session_id || !body.at("canWrite").is_boolean()) throw std::runtime_error("Wrong conversation snapshot");
        state.device_id = checked.sessions[0].device_id; state.title = checked.sessions[0].name; state.can_write = body.at("canWrite");
    }
    if (op == "sync") {
        const auto boundary = number(body.at("boundary")); const auto sync_id = str(body, "syncId");
        if (sync_id.size() != 36) throw std::runtime_error("Invalid sync ID");
        page(body.at("items"));
        for (const auto& event : body.at("items")) if (number(event.at("seq")) > boundary) throw std::runtime_error("Event exceeds snapshot boundary");
        state.sync_id = sync_id; state.through_seq = boundary; state.events = Json::array(); state.messages.clear();
        merge(body.at("items"), false); state.before_seq = before(body); state.needs_sync = false; state.loading = false;
    } else if (op == "ready") { state.ready = true; state.error.clear(); }
    else if (op == "history") {
        merge(body.at("items"), false, true);
        state.before_seq = before(body); state.loading = false;
    }
    else if (op == "requests") { page(body.at("items")); state.requests = body.at("items"); state.requests_before = before(body); state.loading = false; state.requests_changed = false; }
    else if (op == "events") { merge(body.at("items"), true); if (number(body.at("throughSeq")) != state.through_seq) throw std::runtime_error("Invalid contiguous sequence"); state.requests_changed = state.requests_changed || body.value("requestsChanged", false); }
    state.revision++;
}
void ConversationModel::loaded(const Json& event, const std::string& review_token, std::size_t bytes) {
    if (!event.is_object() || event.at("type") != "tool.event" || !event.at("payload").is_object() || bytes > 256 * 1024)
        throw std::runtime_error("Invalid loaded event");
    const auto seq = number(event.at("seq"));
    human_payload(event.at("payload"));
    Json item{{"seq", seq}, {"type", event.at("type")}, {"createdAt", event.at("createdAt")}, {"payload", event.at("payload")}, {"bytes", bytes}};
    if (!review_token.empty()) item["reviewToken"] = review_token;
    for (auto& request : state.requests) if (request.at("seq") == seq) request = item;
    for (auto& cached : state.events) if (cached.at("seq") == seq) cached = item;
    state.messages.erase(std::remove_if(state.messages.begin(), state.messages.end(), [&](const ChatMessage& message) {
        return message.id == "large:" + std::to_string(seq);
    }), state.messages.end());
    project(item); state.loading = false; state.error.clear(); state.revision++;
}
std::string conversation_event_text(const Json& event) {
    if (event.at("payload").is_null()) return "Full content is not loaded.";
    return event.at("payload").dump(2);
}
}
