#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <string>
#include <vector>

namespace connection {
struct ChatMessage { std::string id, role, text; std::uint64_t seq = 0; bool incomplete = false; };
struct ConversationSnapshot {
    std::string session_id, sync_id, device_id, title, error;
    std::string command_id, command_state = "idle", command_type;
    bool supported = false, ready = false, loading = false, can_write = false, needs_sync = false, requests_changed = false;
    std::int64_t before_seq = -1, requests_before = -1;
    std::uint64_t through_seq = 0, revision = 0;
    nlohmann::json events = nlohmann::json::array(), requests = nlohmann::json::array();
    std::vector<ChatMessage> messages;
};
class ConversationModel {
public:
    ConversationSnapshot state;
    void open(const std::string& session_id);
    void disconnected();
    void apply(const nlohmann::json& response);
    void fail(const std::string& op, const std::string& message);
    void begin_command(const std::string& id, const std::string& type);
    void loaded(const nlohmann::json& event, const std::string& review_token, std::size_t bytes);
private:
    void apply_response(const nlohmann::json& response);
    void merge(const nlohmann::json& events, bool live, bool older = false);
    void project(const nlohmann::json& event);
};
std::string conversation_event_text(const nlohmann::json& event);
}
