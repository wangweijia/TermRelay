#pragma once
#include "authorization.h"
#include "lvgl.h"
#include <functional>
#include <map>
#include <set>

namespace app {
class ConversationScreen {
public:
    ConversationScreen(connection::Authorization& connection, std::function<void()> back);
    ~ConversationScreen();
    void open(const std::string& session_id);
    void refresh();
    void close(bool clear_drafts = false);
    bool visible() const { return visible_; }
    bool key(uint32_t key, bool long_pressed);
private:
    enum class Page { Transcript, Menu, Editor, Requests, Approval, Questions, Details, NewCommand };
    struct AnswerField { std::string id, option; lv_obj_t* object; bool custom, multiple; };
    void render(bool latest = false);
    void add_text(const std::string& text);
    lv_obj_t* add_action(const std::string& text, int action);
    void set_footer(const char* left, const char* middle, const char* right);
    void action(int id);
    void back();
    void choose_request(std::size_t index);
    bool request_current() const;
    nlohmann::json collect_answers() const;
    void save_answers();
    std::string answer_key(const std::string& request_id) const;
    void submit(const std::string& type, const nlohmann::json& data, const std::string& review_token = "");
    static void clicked(lv_event_t* event);
    static void answer_changed(lv_event_t* event);
    connection::Authorization& connection_;
    std::function<void()> back_handler_;
    lv_obj_t *root_, *heading_, *status_, *content_, *left_, *middle_, *right_, *editor_ = nullptr;
    lv_obj_t *left_label_, *middle_label_, *right_label_;
    lv_group_t* group_;
    bool visible_ = false, confirm_ = false, read_complete_ = false;
    Page page_ = Page::Transcript;
    connection::ConversationSnapshot snapshot_;
    nlohmann::json selected_;
    std::map<std::string, std::string> drafts_;
    std::map<std::string, nlohmann::json> answer_drafts_;
    std::vector<AnswerField> fields_;
    std::vector<connection::ChatMessage> rendered_messages_;
    std::string submitted_id_, submitted_text_, submitted_request_;
    std::uint64_t rendered_revision_ = 0;
    bool rendered_online_ = false;
};
}
