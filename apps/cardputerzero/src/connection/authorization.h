#pragma once
#include <memory>
#include <string>
#include <vector>
#include <cstdint>
#include "conversation.h"

namespace connection {
enum class State { Idle, Starting, Waiting, Connecting, Connected, Retrying, Denied, Expired, Revoked, Error };
struct Snapshot {
    State state = State::Idle;
    std::string origin;
    std::string message;
    unsigned device_count = 0;
    bool has_credential = false;
};
struct DeviceSummary { std::string id, name, status, platform; };
struct SessionSummary { std::string id, device_id, workspace_id, tool_key, name, runtime_mode, status; };
struct ListingSnapshot {
    std::vector<DeviceSummary> devices;
    std::vector<SessionSummary> sessions;
    std::string device_id, next_devices, next_sessions, error;
    bool loading = false;
    bool supported = false;
    std::uint64_t revision = 0;
};
std::string normalize_origin(const std::string& input, bool allow_test_loopback = false);
std::string default_state_directory();
class Authorization {
public:
    explicit Authorization(std::string directory = default_state_directory(), bool allow_test_loopback = false);
    ~Authorization();
    Authorization(const Authorization&) = delete;
    Authorization& operator=(const Authorization&) = delete;
    void connect(const std::string& origin);
    void cancel();
    void forget();
    Snapshot snapshot() const;
    ListingSnapshot listing() const;
    void list_devices(const std::string& cursor = "");
    void list_sessions(const std::string& device_id, const std::string& cursor = "");
    ConversationSnapshot conversation() const;
    void open_conversation(const std::string& session_id);
    void close_conversation();
    void acknowledge_unknown_command();
    void conversation_read(const std::string& op, const nlohmann::json& arguments = nlohmann::json::object());
    std::string conversation_command(const std::string& type, const nlohmann::json& data, const std::string& review_token = "");
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
}
