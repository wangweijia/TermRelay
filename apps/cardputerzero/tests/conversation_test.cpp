#include "conversation.h"
#include <iostream>
#include <stdexcept>
using Json = nlohmann::json;
void require(bool condition) { if (!condition) throw std::runtime_error("Conversation assertion failed"); }
const std::string sync_id = "10000000-0000-4000-8000-000000000001";
Json item(unsigned seq, const std::string& content = "text") {
    return {{"seq", seq}, {"type", "tool.event"}, {"createdAt", "2026-11-10T00:00:00Z"}, {"bytes", 200},
        {"payload", {{"kind", "assistant.delta"}, {"correlation", {{"turnId", "turn"}, {"itemId", "answer"}}}, {"data", {{"text", content}}}}}};
}
Json session() { return {{"id", "chat"}, {"deviceId", "mac"}, {"workspaceId", "opaque"}, {"toolKey", "codex"}, {"displayName", "Chat"}, {"runtimeMode", "acp"}, {"status", "running"}}; }
Json response(const std::string& op, Json body) { return {{"op", op}, {"sessionId", "chat"}, {"body", body}}; }
void ready(connection::ConversationModel& model) {
    model.open("chat");
    model.apply(response("sync", {{"syncId", sync_id}, {"boundary", 2}, {"session", session()}, {"canWrite", true}, {"items", Json::array({item(1,"A"),item(2,"B")})}, {"beforeSeq",1}}));
    model.apply(response("ready", {{"syncId",sync_id}}));
}
int main() {
    try {
        connection::ConversationModel model; ready(model);
        require(model.state.ready && model.state.through_seq == 2 && model.state.messages[0].text == "AB");
        const auto live = [&](Json items, unsigned through) { return response("events", {{"syncId",sync_id},{"session",session()},{"canWrite",true},{"items",items},{"throughSeq",through},{"requestsChanged",false}}); };
        model.apply(live(Json::array({item(3,"C")}),3));
        model.apply(live(Json::array({item(3,"duplicate")}),3));
        require(model.state.messages[0].text == "ABC");
        try { model.apply(live(Json::array({item(4,"D"),item(6,"gap")}),6)); require(false); } catch(const std::runtime_error&) {}
        require(model.state.needs_sync && !model.state.ready && model.state.through_seq == 3 && model.state.messages[0].text == "ABC");
        ready(model);
        auto wrong = response("history", {{"syncId",sync_id},{"items",Json::array({item(0,"0")})},{"beforeSeq",nullptr}});
        wrong["sessionId"] = "another-session"; model.apply(wrong); require(model.state.events.size() == 2);
        wrong["sessionId"] = "chat"; wrong["body"]["syncId"] = "old-sync"; model.apply(wrong); require(model.state.events.size() == 2);
        wrong["body"]["syncId"] = sync_id; model.apply(wrong); require(model.state.messages[0].text == "0AB" && model.state.before_seq == -1);
        const std::string command = "20000000-0000-4000-8000-000000000001";
        model.begin_command(command,"tool.turn.start"); model.disconnected(); require(model.state.command_state == "unknown");
        model.apply(response("ack", {{"commandId",command},{"ack",{{"commandId",command},{"status","accepted"}}}}));
        require(model.state.command_state == "unknown");
        model.apply(response("status", {{"commandId",command},{"ack",{{"commandId",command},{"status","completed"}}}}));
        require(model.state.command_state == "confirmed");
        model.apply(response("ack", {{"commandId",command},{"ack",{{"commandId",command},{"status","failed"}}}}));
        require(model.state.command_state == "confirmed");
        ready(model);
        auto large = item(3); large["payload"] = nullptr; large["bytes"] = 40000;
        model.apply(response("requests",{{"syncId",sync_id},{"items",Json::array({large})},{"beforeSeq",nullptr}}));
        require(model.state.requests[0]["payload"].is_null());
        auto loaded = item(3); loaded["payload"]["kind"] = "approval.requested";
        loaded["payload"]["data"] = {{"approvalId","approval"},{"turnId","turn"},{"title","Review"}};
        model.loaded({{"seq",3},{"type","tool.event"},{"createdAt","2026-11-10T00:00:00Z"},{"payload",loaded["payload"]}},sync_id,40000);
        require(model.state.requests[0]["reviewToken"] == sync_id && model.state.requests[0]["payload"].is_object());
        ready(model);
        for(unsigned seq=3;seq<150;seq++) model.apply(live(Json::array({item(seq,"字")}),seq));
        require(model.state.events.size() <=128 && model.state.through_seq ==149);
        model.apply(response("history", {{"syncId",sync_id},{"items",Json::array({item(1,"older")})},{"beforeSeq",1}}));
        require(model.state.events.front().at("seq") == 1 && model.state.messages.front().text.rfind("older",0) == 0);
        auto too_many=Json::array(); for(unsigned seq=150;seq<171;seq++) too_many.push_back(item(seq));
        const auto version=model.state.through_seq;
        try { model.apply(live(too_many,170)); require(false); } catch(const std::runtime_error&) {}
        require(model.state.through_seq ==version);
        ready(model);
        for(unsigned seq=3;seq<150;seq++) {
            auto message = item(seq); message["payload"]["kind"] = "user.message";
            model.apply(live(Json::array({message}),seq));
        }
        auto old = item(1,"old message"); old["payload"]["kind"] = "user.message";
        model.apply(response("history", {{"syncId",sync_id},{"items",Json::array({old})},{"beforeSeq",1}}));
        require(model.state.messages.size() ==64 && model.state.messages.front().seq ==1);
        auto malformed = item(150); malformed["payload"] = {{"kind","user-input.requested"},{"data",{{"turnId","turn"},{"requestId","question"},{"questions","invalid"}}}};
        try { model.apply(response("requests",{{"syncId",sync_id},{"items",Json::array({malformed})},{"beforeSeq",nullptr}})); require(false); } catch(const std::exception&) {}
        require(model.state.requests.empty());
        std::cout << "Conversation snapshot, replay, receipts and bounded content passed\n";
        return 0;
    } catch(const std::exception& error) { std::cerr<<error.what()<<'\n';return 1; }
}
