#include "authorization.h"
#include <chrono>
#include <thread>
#include <iostream>
#include <stdexcept>
#ifdef TERMRELAY_HEADLESS_UI
#include "conversation_screen.h"
#include <memory>
#include <vector>
#endif
using Json = nlohmann::json;
using namespace std::chrono_literals;
int main(int argc, char** argv) {
    if (argc != 3) return 2;
    try {
        connection::Authorization client(argv[2], true); client.connect(argv[1]);
#ifdef TERMRELAY_HEADLESS_UI
        lv_init(); auto* display = lv_display_create(320,170);
        std::vector<std::uint32_t> pixels(320*32);
        lv_display_set_buffers(display,pixels.data(),nullptr,pixels.size()*sizeof(std::uint32_t),LV_DISPLAY_RENDER_MODE_PARTIAL);
        lv_display_set_flush_cb(display,+[](lv_display_t* d,const lv_area_t*,uint8_t*){lv_display_flush_ready(d);});
        std::unique_ptr<app::ConversationScreen> ui;
        const auto pump = [&] { lv_tick_inc(20); if(ui)ui->refresh();lv_timer_handler(); };
        const auto find = [&](auto predicate) {
            const auto visit = [&](auto&& self,lv_obj_t* object)->lv_obj_t* {
                if(predicate(object))return object;
                for(uint32_t i=0;i<lv_obj_get_child_count(object);i++)if(auto* found=self(self,lv_obj_get_child(object,i)))return found;
                return nullptr;
            };return visit(visit,lv_screen_active());
        };
        const auto button = [&](const std::string& caption) {
            return find([&](lv_obj_t* object){
                if(!lv_obj_check_type(object,&lv_button_class)||!lv_obj_get_child_count(object))return false;
                auto* label=lv_obj_get_child(object,0);
                return lv_obj_check_type(label,&lv_label_class)&&std::string(lv_label_get_text(label)).rfind(caption,0)==0;
            });
        };
        const auto click = [&](const std::string& caption) {
            auto* object=button(caption);
            if(!object||lv_obj_has_state(object,LV_STATE_DISABLED))throw std::runtime_error("UI action unavailable: "+caption);
            lv_obj_send_event(object,LV_EVENT_CLICKED,nullptr);pump();
        };
        const auto input = [&] { return find([](lv_obj_t* object){return lv_obj_check_type(object,&lv_textarea_class);}); };
        const auto scroll_end = [&] {
            auto* scroller=lv_obj_get_child(lv_screen_active(),2);
            lv_obj_update_layout(lv_screen_active());lv_obj_scroll_to_y(scroller,LV_COORD_MAX,LV_ANIM_OFF);pump();
        };
        const auto requests = [&] { click("Actions");click("Approvals / questions"); };
#else
        const auto pump = [] {};
#endif
        const auto wait = [&](auto condition) {
            const auto deadline = std::chrono::steady_clock::now() + 30s;
            while (std::chrono::steady_clock::now() < deadline) {
                pump(); if (condition()) return;
                const auto status = client.snapshot();
                if (status.state == connection::State::Error) throw std::runtime_error(status.message);
                std::this_thread::sleep_for(20ms);
            }
            throw std::runtime_error("Native conversation probe timed out: " + client.conversation().error);
        };
        wait([&] { return client.snapshot().state == connection::State::Connected; });
#ifdef TERMRELAY_HEADLESS_UI
        ui=std::make_unique<app::ConversationScreen>(client,[]{});ui->open("chat-session");
#else
        client.open_conversation("chat-session");
#endif
        wait([&] { return client.conversation().ready; });
        auto state = client.conversation();
        if (state.before_seq < 0 || state.events.size() != 20) throw std::runtime_error("Expected recent history page");
        client.conversation_read("history", {{"beforeSeq", state.before_seq}});
        wait([&] { const auto s=client.conversation();return s.before_seq<0&&!s.events.empty()&&s.events.front().at("seq")==0; });
        const auto send = [&](const std::string& type, Json data, const std::string& token = "") {
            const auto id = client.conversation_command(type, data, token);
            if (id.empty()) throw std::runtime_error("Native command could not be queued");
            wait([&] { return client.conversation().command_id == id && client.conversation().command_state == "confirmed"; });
        };
#ifdef TERMRELAY_HEADLESS_UI
        click("Write");lv_textarea_set_text(input(),"hello from native");click("Send");
        if(std::string(lv_textarea_get_text(input()))!="hello from native"||!lv_obj_has_state(button("Send"),LV_STATE_DISABLED))
            throw std::runtime_error("UI cleared the draft before confirmation or allowed duplicate submission");
        wait([&]{return client.conversation().command_state=="confirmed";});pump();
        click("Write");if(std::string(lv_textarea_get_text(input()))!="")throw std::runtime_error("Confirmed draft was not cleared");click("Back");
#else
        send("tool.turn.start", {{"text", "hello from native"}});
#endif
        wait([&] { for (const auto& message:client.conversation().messages) if(message.text=="native answer")return true;return false; });
        const auto request = [&](const std::string& id) {
            wait([&] { for(const auto& item:client.conversation().requests) if(item.at("payload").is_object()) {
                const auto data=item.at("payload").at("data");if(data.value("approvalId",data.value("requestId",std::string()))==id)return true;
            }return false; });
            for(const auto& item:client.conversation().requests) if(item.at("payload").is_object()) {
                const auto data=item.at("payload").at("data");if(data.value("approvalId",data.value("requestId",std::string()))==id)return item;
            }
            throw std::runtime_error("Missing native request");
        };
        auto approval = request("small-approval");
#ifdef TERMRELAY_HEADLESS_UI
        requests();click("Approval: Synthetic command");scroll_end();
        const auto previous=client.conversation().command_id;click("Allow once");
        if(client.conversation().command_id!=previous)throw std::runtime_error("UI approval skipped explicit confirmation");
        click("Confirm allow");wait([&]{return client.conversation().command_state=="confirmed";});pump();
#else
        send("tool.approval.resolve", {{"approvalId","small-approval"},{"turnId","turn"},{"decision","allowOnce"}}, approval.at("reviewToken"));
#endif
        auto question = request("question");
#ifdef TERMRELAY_HEADLESS_UI
        requests();click("Questions from agent");
        for(const auto& prefix: {"one","two"}) {
            auto* checkbox=find([&](lv_obj_t* object){return lv_obj_check_type(object,&lv_checkbox_class)&&std::string(lv_checkbox_get_text(object)).rfind(prefix,0)==0;});
            if(!checkbox)throw std::runtime_error("UI option is missing");lv_obj_add_state(checkbox,LV_STATE_CHECKED);lv_obj_send_event(checkbox,LV_EVENT_VALUE_CHANGED,nullptr);
        }
        if(!input()||!lv_textarea_get_password_mode(input()))throw std::runtime_error("Secret answer was not masked");
        lv_textarea_set_text(input(),"free answer");click("Submit");wait([&]{return client.conversation().command_state=="confirmed";});pump();
#else
        send("tool.user-input.resolve", {{"requestId","question"},{"turnId","turn"},
            {"answers",{{"choice",Json::array({"one","two"})},{"free",Json::array({"free answer"})}}}}, question.at("reviewToken"));
#endif
        wait([&] { for(const auto& item:client.conversation().requests) if(item.at("payload").is_null())return true;return false; });
#ifdef TERMRELAY_HEADLESS_UI
        requests();click("Load full request");
        if(!lv_obj_has_state(button("Allow once"),LV_STATE_DISABLED))throw std::runtime_error("Unloaded approval could be approved");
        click("Load complete content");
#else
        for(const auto& item:client.conversation().requests) if(item.at("payload").is_null()) client.conversation_read("event",{{"seq",item.at("seq")},{"offset",0}});
#endif
        approval = request("large-approval");
        if(approval.at("payload").at("data").at("detail").get_ref<const std::string&>().size()!=60000)throw std::runtime_error("Large request was truncated");
#ifdef TERMRELAY_HEADLESS_UI
        pump();scroll_end();click("Allow once");click("Confirm allow");wait([&]{return client.conversation().command_state=="confirmed";});pump();
#else
        send("tool.approval.resolve", {{"approvalId","large-approval"},{"turnId","turn"},{"decision","allowOnce"}}, approval.at("reviewToken"));
#endif
        std::cout << "CHAT_INTERACTION_OK" << std::endl;
        const auto lost = client.conversation_command("tool.turn.start",{{"text","lost ack"}});
        if(lost.empty())throw std::runtime_error("Lost-ACK test was not queued");
        wait([&] { return client.conversation().command_state=="unknown"; });
        wait([&] { return client.conversation().ready && client.conversation().command_id==lost && client.conversation().command_state=="confirmed"; });
        std::cout << "CHAT_RECOVERED" << std::endl;
        wait([&] { return client.snapshot().state==connection::State::Revoked; });
        state=client.conversation();
        if(!state.session_id.empty()||!state.requests.empty()||!state.events.empty()||!state.messages.empty())throw std::runtime_error("Revocation retained conversation content");
#ifdef TERMRELAY_HEADLESS_UI
        ui->close(true);lv_screen_load(lv_obj_create(nullptr));ui.reset();lv_display_delete(display);lv_deinit();
#endif
        std::cout << "CHAT_REVOKED" << std::endl;
        return 0;
    } catch(const std::exception& error) { std::cerr<<error.what()<<std::endl;return 1; }
}
