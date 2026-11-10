#include "conversation_screen.h"
#include <algorithm>
#include <ctime>
#include <sstream>
#include <iomanip>

namespace app {
namespace {
using Json = nlohmann::json;
std::string text(const Json& data, const char* key) { auto it = data.find(key); return it != data.end() && it->is_string() ? it->get<std::string>() : ""; }
void disabled(lv_obj_t* object, bool value) { if (value) lv_obj_add_state(object, LV_STATE_DISABLED); else lv_obj_remove_state(object, LV_STATE_DISABLED); }
bool expired(const Json& data) {
    const auto value = text(data, "expiresAt"); if (value.empty()) return false;
    std::tm utc{}; std::istringstream input(value.substr(0, 19)); input >> std::get_time(&utc, "%Y-%m-%dT%H:%M:%S");
    return input.fail() || timegm(&utc) <= std::time(nullptr);
}
}
ConversationScreen::ConversationScreen(connection::Authorization& connection, std::function<void()> back)
    : connection_(connection), back_handler_(std::move(back)) {
    root_ = lv_obj_create(nullptr); lv_obj_set_style_pad_all(root_, 0, 0); lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    heading_ = lv_label_create(root_); lv_obj_set_pos(heading_, 4, 0); lv_obj_set_size(heading_, 200, 20); lv_label_set_long_mode(heading_, LV_LABEL_LONG_CLIP);
    status_ = lv_label_create(root_); lv_obj_set_pos(status_, 204, 0); lv_obj_set_size(status_, 112, 20);
    lv_obj_set_style_text_font(status_, &lv_font_montserrat_12, 0); lv_obj_set_style_text_align(status_, LV_TEXT_ALIGN_RIGHT, 0);
    content_ = lv_obj_create(root_); lv_obj_set_pos(content_, 0, 20); lv_obj_set_size(content_, 320, 126);
    lv_obj_set_style_pad_all(content_, 3, 0); lv_obj_set_style_pad_row(content_, 6, 0); lv_obj_set_flex_flow(content_, LV_FLEX_FLOW_COLUMN);
    const auto footer = [&](int x, lv_obj_t** caption) {
        auto* button = lv_button_create(root_); lv_obj_set_pos(button, x, 146); lv_obj_set_size(button, 104, 24); lv_obj_set_style_pad_all(button, 0, 0);
        *caption = lv_label_create(button); lv_obj_center(*caption); lv_obj_set_style_text_font(*caption, &lv_font_montserrat_12, 0);
        lv_obj_add_event_cb(button, clicked, LV_EVENT_CLICKED, this); return button;
    };
    left_ = footer(0, &left_label_); middle_ = footer(108, &middle_label_); right_ = footer(216, &right_label_);
    group_ = lv_group_create();
}
ConversationScreen::~ConversationScreen() { lv_group_delete(group_); lv_obj_delete(root_); }
void ConversationScreen::open(const std::string& id) {
    connection_.open_conversation(id); snapshot_ = connection_.conversation();
    if (snapshot_.session_id != id) return;
    visible_ = true; page_ = Page::Transcript; submitted_id_.clear(); fields_.clear();
    lv_screen_load(root_);
    for (auto* input = lv_indev_get_next(nullptr); input; input = lv_indev_get_next(input))
        if (lv_indev_get_type(input) == LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input) == LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input, group_);
    render(true);
}
void ConversationScreen::close(bool clear_drafts) {
    if (editor_) drafts_[snapshot_.session_id] = lv_textarea_get_text(editor_);
    connection_.close_conversation(); visible_ = false; editor_ = nullptr; fields_.clear(); selected_ = Json();
    if (clear_drafts) { drafts_.clear(); answer_drafts_.clear(); }
    back_handler_();
}
bool ConversationScreen::key(uint32_t key, bool long_pressed) {
    if (!visible_ || key != LV_KEY_ESC) return false;
    if (!long_pressed) back(); return true;
}
void ConversationScreen::add_text(const std::string& value) {
    auto* label = lv_label_create(content_); lv_obj_set_width(label, 298); lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_label_set_text(label, value.c_str());
}
lv_obj_t* ConversationScreen::add_action(const std::string& value, int id) {
    auto* button = lv_button_create(content_); lv_obj_set_width(button, 298); lv_obj_set_height(button, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(button, 5, 0); lv_obj_set_user_data(button, reinterpret_cast<void*>(static_cast<intptr_t>(id)));
    auto* label = lv_label_create(button); lv_obj_set_width(label, 284); lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP); lv_label_set_text(label, value.c_str());
    lv_obj_add_event_cb(button, clicked, LV_EVENT_CLICKED, this); lv_group_add_obj(group_, button); return button;
}
void ConversationScreen::set_footer(const char* left, const char* middle, const char* right) {
    lv_label_set_text(left_label_, left); lv_label_set_text(middle_label_, middle); lv_label_set_text(right_label_, right);
    for (auto* button : {left_, middle_, right_}) { lv_obj_remove_state(button, LV_STATE_DISABLED); lv_group_add_obj(group_, button); }
    disabled(middle_, !*middle); disabled(right_, !*right);
}
bool ConversationScreen::request_current() const {
    if (!selected_.is_object() || !selected_.contains("payload") || !selected_.at("payload").is_object()) return false;
    const auto& data = selected_.at("payload").at("data");
    return !expired(data) && std::any_of(snapshot_.requests.begin(), snapshot_.requests.end(), [&](const Json& item) {
        return item.at("seq") == selected_.at("seq") && text(item, "reviewToken") == text(selected_, "reviewToken");
    });
}
void ConversationScreen::render(bool latest) {
    if (editor_) drafts_[snapshot_.session_id] = lv_textarea_get_text(editor_);
    editor_ = nullptr; fields_.clear(); rendered_revision_ = snapshot_.revision;
    rendered_online_ = connection_.snapshot().state == connection::State::Connected;
    auto* old_focus = lv_group_get_focused(group_);
    lv_group_remove_all_objs(group_); lv_obj_clean(content_);
    lv_label_set_text(heading_, page_ == Page::Editor ? "Write message" : page_ == Page::Requests ? "Pending requests" : page_ == Page::Approval ? "Approval details"
        : page_ == Page::Questions ? "Answer questions" : page_ == Page::Menu ? "Conversation actions" : snapshot_.title.empty() ? "Conversation" : snapshot_.title.c_str());
    lv_label_set_text(status_, !rendered_online_ ? "Offline (cache)" : !snapshot_.error.empty() ? "Check status" : snapshot_.command_state == "waiting" ? "Sending..." : snapshot_.ready ? "Live" : "Synchronizing");
    if (page_ == Page::Transcript) {
        if (snapshot_.messages.empty()) add_text(snapshot_.loading ? "Loading conversation..." : "No public messages in this history window.");
        rendered_messages_ = snapshot_.messages;
        for (std::size_t i = 0; i < snapshot_.messages.size(); i++) {
            const auto& message = snapshot_.messages[i];
            add_action(message.role + "\n" + message.text, 1000 + static_cast<int>(i));
        }
        if (!snapshot_.error.empty()) add_text(snapshot_.error);
        set_footer("Back", "Actions", "Write"); disabled(right_, !snapshot_.ready || !snapshot_.can_write || !rendered_online_);
    } else if (page_ == Page::Menu) {
        add_action("Read older history", 10); add_action("Show latest messages", 11); add_action("Approvals / questions", 12);
        add_action("Check last command result", 13); add_action("Resynchronize conversation", 14);
        add_action("Stop the current turn", 15);
        if (snapshot_.command_state == "unknown") add_action("Send a new command despite unknown result...", 16);
        if (!snapshot_.error.empty()) add_text(snapshot_.error);
        set_footer("Back", "", "");
    } else if (page_ == Page::Editor) {
        editor_ = lv_textarea_create(content_); lv_obj_set_size(editor_, 298, 112); lv_textarea_set_max_length(editor_, 4000);
        lv_textarea_set_placeholder_text(editor_, "Message (Enter adds a line)"); lv_textarea_set_text(editor_, drafts_[snapshot_.session_id].c_str());
        lv_group_add_obj(group_, editor_); set_footer("Back", "Status", "Send");
        disabled(editor_, snapshot_.command_state == "waiting");
        disabled(right_, !snapshot_.ready || !snapshot_.can_write || !rendered_online_ || snapshot_.command_state == "waiting" || snapshot_.command_state == "unknown");
    } else if (page_ == Page::Requests) {
        for (std::size_t i = 0; i < snapshot_.requests.size(); i++) {
            const auto& item = snapshot_.requests[i];
            const auto payload = item.value("payload", Json());
            const auto data = payload.is_object() ? payload.value("data", Json::object()) : Json::object();
            add_action((payload.is_null() ? "Load full request" : text(payload, "kind") == "approval.requested" ? "Approval: " + text(data, "title") : "Questions from agent")
                + "\nseq " + std::to_string(item.at("seq").get<std::uint64_t>()), 2000 + static_cast<int>(i));
        }
        if (snapshot_.requests.empty()) add_text("No pending requests on this page.");
        set_footer("Back", "Refresh", "Older"); disabled(right_, snapshot_.requests_before < 0 || !rendered_online_);
    } else if (page_ == Page::Approval || page_ == Page::Details) {
        if (selected_.at("payload").is_null()) {
            add_text("Content not loaded. Approval is disabled until the complete request is loaded and reviewed.");
            if (selected_.at("bytes").get<std::size_t>() <= 256 * 1024) add_action("Load complete content", 20);
            else add_text("This content exceeds the device budget. Read and handle it in Web.");
        } else {
            const auto value = connection::conversation_event_text(selected_);
            if (value.size() <= 64 * 1024) add_text(value);
            else add_text("Full content is larger than the screen budget. Use Web; approval is disabled.");
        }
        lv_group_add_obj(group_, content_);
        if (page_ == Page::Approval) {
            add_action("Cancel this approval request", 21);
            set_footer("Back", "Deny", confirm_ ? "Confirm allow" : "Allow once");
            disabled(middle_, !request_current() || !snapshot_.ready || !snapshot_.can_write || !rendered_online_ || snapshot_.command_state == "waiting" || snapshot_.command_state == "unknown");
            disabled(right_, lv_obj_has_state(middle_, LV_STATE_DISABLED) || selected_.at("payload").is_null()
                || connection::conversation_event_text(selected_).size() > 64 * 1024 || text(selected_, "reviewToken").empty());
        } else set_footer("Back", "", "");
    } else if (page_ == Page::Questions) {
        const auto& data = selected_.at("payload").at("data"); const auto& questions = data.at("questions");
        if (!questions.is_array() || questions.size() > 16 || data.dump().size() > 64 * 1024) {
            add_text("Questions exceed device display limits. Please answer in Web."); set_footer("Back", "", "");
        } else {
            const auto saved = answer_drafts_.find(answer_key(text(data, "requestId")));
            for (const auto& question : questions) {
                const auto id = text(question, "id"); const bool multiple = question.value("allowsMultiple", false);
                add_text(text(question, "header") + "\n" + text(question, "question"));
                const auto options = question.value("options", Json::array());
                if (!options.is_array() || options.size() > 32) { add_text("Too many options; answer in Web."); set_footer("Back", "", ""); return; }
                const Json prior = saved != answer_drafts_.end() && saved->second.contains(id) ? saved->second.at(id) : Json::array();
                for (const auto& option : options) {
                    const auto value = text(option, "label"); auto* checkbox = lv_checkbox_create(content_);
                    lv_obj_set_width(checkbox, 294); lv_checkbox_set_text(checkbox, (value + " — " + text(option, "description")).c_str());
                    if (std::find(prior.begin(), prior.end(), value) != prior.end()) lv_obj_add_state(checkbox, LV_STATE_CHECKED);
                    fields_.push_back({id, value, checkbox, false, multiple}); lv_group_add_obj(group_, checkbox);
                    lv_obj_add_event_cb(checkbox, answer_changed, LV_EVENT_VALUE_CHANGED, this);
                }
                if (question.value("allowsOther", false) || options.empty()) {
                    auto* input = lv_textarea_create(content_); lv_obj_set_size(input, 294, 62); lv_textarea_set_max_length(input, 1024);
                    lv_textarea_set_password_mode(input, question.value("isSecret", false));
                    lv_textarea_set_placeholder_text(input, options.empty() ? "Your answer" : "Other answer");
                    for (const auto& value : prior) if (value.is_string() && std::none_of(options.begin(), options.end(), [&](const Json& option) { return option.at("label") == value; })) lv_textarea_set_text(input, value.get_ref<const std::string&>().c_str());
                    fields_.push_back({id, "", input, true, multiple}); lv_group_add_obj(group_, input);
                    lv_obj_add_event_cb(input, answer_changed, LV_EVENT_VALUE_CHANGED, this);
                }
            }
            set_footer("Back", "Status", "Submit");
            disabled(right_, !request_current() || !snapshot_.ready || !rendered_online_ || snapshot_.command_state == "waiting" || snapshot_.command_state == "unknown");
        }
    } else {
        add_text("The previous command may already have executed. Sending again may duplicate work. Check status first. Continue with a NEW command anyway?");
        set_footer("Back", "Check", "New anyway");
    }
    if (old_focus == left_ || old_focus == middle_ || old_focus == right_) lv_group_focus_obj(old_focus);
    else if (page_ == Page::Approval) lv_group_focus_obj(middle_);
    else if (page_ == Page::Transcript) lv_group_focus_obj(middle_);
    if (latest && page_ == Page::Transcript) lv_obj_scroll_to_y(content_, LV_COORD_MAX, LV_ANIM_OFF);
}
void ConversationScreen::refresh() {
    if (!visible_) return;
    const auto next = connection_.conversation(); const auto online = connection_.snapshot().state == connection::State::Connected;
    const bool changed = next.revision != snapshot_.revision || online != rendered_online_;
    snapshot_ = next;
    if (!submitted_id_.empty() && snapshot_.command_id == submitted_id_ && snapshot_.command_state == "confirmed") {
        if (editor_) drafts_[snapshot_.session_id] = lv_textarea_get_text(editor_);
        if (snapshot_.command_type == "tool.turn.start" && drafts_[snapshot_.session_id] == submitted_text_) drafts_[snapshot_.session_id].clear();
        if (!submitted_request_.empty()) answer_drafts_.erase(answer_key(submitted_request_));
        submitted_id_.clear(); submitted_request_.clear();
        if (page_ == Page::Editor || page_ == Page::Questions || page_ == Page::Approval) { page_ = Page::Transcript; editor_ = nullptr; render(true); return; }
    }
    if (!changed) return;
    if (page_ == Page::Transcript) {
        const auto focused = lv_group_get_focused(group_);
        const bool reading = lv_obj_get_scroll_bottom(content_) > 4 || (focused && lv_obj_get_parent(focused) == content_);
        if (!reading || snapshot_.loading || !snapshot_.ready) render(true);
        else lv_label_set_text(status_, online ? "New updates" : "Offline (cache)");
    } else if (page_ == Page::Requests) render();
    else if (page_ == Page::Approval || page_ == Page::Details) {
        if (!selected_.is_null() && selected_.at("payload").is_null()) {
            const auto loaded = std::find_if(snapshot_.requests.begin(), snapshot_.requests.end(), [&](const Json& item) { return item.at("seq") == selected_.at("seq"); });
            if (loaded != snapshot_.requests.end() && loaded->at("payload").is_object()) { selected_ = *loaded; choose_request(static_cast<std::size_t>(loaded - snapshot_.requests.begin())); return; }
            const auto event = std::find_if(snapshot_.events.begin(), snapshot_.events.end(), [&](const Json& item) { return item.at("seq") == selected_.at("seq"); });
            if (event != snapshot_.events.end() && event->at("payload").is_object()) { selected_ = *event; render(); return; }
        }
        if (page_ == Page::Approval) {
            disabled(middle_, !online || !snapshot_.ready || !snapshot_.can_write || !request_current() || snapshot_.command_state == "waiting" || snapshot_.command_state == "unknown");
            disabled(right_, lv_obj_has_state(middle_, LV_STATE_DISABLED) || selected_.at("payload").is_null() || text(selected_, "reviewToken").empty()
                || connection::conversation_event_text(selected_).size() > 64 * 1024);
        }
    } else if (page_ == Page::Editor || page_ == Page::Questions) {
        const bool blocked = !online || !snapshot_.ready || !snapshot_.can_write || snapshot_.command_state == "waiting" || snapshot_.command_state == "unknown";
        disabled(right_, blocked || (page_ == Page::Questions && !request_current()));
        if (editor_) disabled(editor_, snapshot_.command_state == "waiting");
        lv_label_set_text(status_, !online ? "Offline (cache)" : snapshot_.command_state == "waiting" ? "Sending..." : snapshot_.command_state == "unknown" ? "Result unknown" : "Live");
    }
    rendered_online_ = online;
}
void ConversationScreen::back() {
    confirm_ = false; read_complete_ = false;
    if (page_ == Page::Transcript) { close(); return; }
    if (editor_) drafts_[snapshot_.session_id] = lv_textarea_get_text(editor_);
    if (page_ == Page::Questions) save_answers();
    page_ = (page_ == Page::Approval || page_ == Page::Questions) ? Page::Requests : Page::Transcript;
    render();
}
void ConversationScreen::choose_request(std::size_t index) {
    if (index >= snapshot_.requests.size()) return;
    selected_ = snapshot_.requests[index]; confirm_ = false; read_complete_ = false;
    if (selected_.at("payload").is_null()) page_ = Page::Approval;
    else page_ = text(selected_.at("payload"), "kind") == "approval.requested" ? Page::Approval : Page::Questions;
    render();
}
Json ConversationScreen::collect_answers() const {
    Json answers = Json::object();
    for (const auto& field : fields_) {
        if (!answers.contains(field.id)) answers[field.id] = Json::array();
        if (field.custom) { const std::string value = lv_textarea_get_text(field.object); if (!value.empty()) answers[field.id].push_back(value); }
        else if (lv_obj_has_state(field.object, LV_STATE_CHECKED)) answers[field.id].push_back(field.option);
    }
    return answers;
}
std::string ConversationScreen::answer_key(const std::string& request_id) const {
    return snapshot_.session_id + ":" + request_id;
}
void ConversationScreen::save_answers() {
    const auto key = answer_key(text(selected_.at("payload").at("data"), "requestId"));
    if (answer_drafts_.size() >= 16 && !answer_drafts_.count(key)) answer_drafts_.erase(answer_drafts_.begin());
    answer_drafts_[key] = collect_answers();
}
void ConversationScreen::submit(const std::string& type, const Json& data, const std::string& token) {
    const auto id = connection_.conversation_command(type, data, token);
    if (id.empty()) { lv_label_set_text(status_, "Check status"); return; }
    submitted_id_ = id;
    submitted_request_ = type == "tool.user-input.resolve" ? text(data, "requestId") : "";
    submitted_text_ = type == "tool.turn.start" ? text(data, "text") : "";
    refresh();
}
void ConversationScreen::action(int id) {
    if (id == -1) { back(); return; }
    if (id >= 2000) { choose_request(static_cast<std::size_t>(id - 2000)); return; }
    if (id >= 1000) {
        const auto index = static_cast<std::size_t>(id - 1000); if (index >= rendered_messages_.size()) return;
        const auto seq = rendered_messages_[index].seq;
        const auto event = std::find_if(snapshot_.events.begin(), snapshot_.events.end(), [&](const Json& item) { return item.at("seq") == seq; });
        if (event == snapshot_.events.end()) { lv_label_set_text(status_, "Load history"); return; }
        selected_ = *event; page_ = Page::Details; render(); return;
    }
    if (id == 10) {
        if (snapshot_.before_seq >= 0) connection_.conversation_read("history", {{"beforeSeq", snapshot_.before_seq}});
        page_ = Page::Transcript; render(); return;
    }
    if (id == 11) { connection_.conversation_read("sync"); page_ = Page::Transcript; render(true); return; }
    if (id == 12) { connection_.conversation_read("requests"); page_ = Page::Requests; render(); return; }
    if (id == 13) { if (!snapshot_.command_id.empty()) connection_.conversation_read("status", {{"commandId", snapshot_.command_id}}); return; }
    if (id == 14) { connection_.conversation_read("sync"); page_ = Page::Transcript; render(); return; }
    if (id == 15) {
        std::string turn;
        for (auto it = snapshot_.events.rbegin(); it != snapshot_.events.rend(); ++it) if (it->at("payload").is_object()) {
            const auto& payload = it->at("payload"); const auto data = payload.value("data", Json::object());
            if (text(payload, "kind") == "turn.completed") break;
            if (!text(data, "turnId").empty()) { turn = text(data, "turnId"); break; }
        }
        if (!turn.empty()) submit("tool.turn.interrupt", {{"turnId", turn}}); return;
    }
    if (id == 16) { page_ = Page::NewCommand; render(); return; }
    if (id == 20) {
        if (selected_.at("bytes").get<std::size_t>() <= 256 * 1024) connection_.conversation_read("event", {{"seq", selected_.at("seq")}, {"offset", 0}});
        return;
    }
    if (id == 21) {
        if (page_ == Page::Approval && request_current()) {
            const auto& data = selected_.at("payload").at("data");
            submit("tool.approval.resolve", {{"approvalId", data.at("approvalId")}, {"turnId", data.at("turnId")}, {"decision", "cancel"}});
        }
        return;
    }
    if (id == -2) {
        if (page_ == Page::Transcript) { page_ = Page::Menu; render(); }
        else if (page_ == Page::Approval && request_current()) {
            const auto& data = selected_.at("payload").at("data");
            submit("tool.approval.resolve", {{"approvalId", data.at("approvalId")}, {"turnId", data.at("turnId")}, {"decision", "deny"}});
        } else if (page_ == Page::Requests) connection_.conversation_read("requests");
        else action(13);
    } else if (id == -3) {
        if (page_ == Page::Transcript) { page_ = Page::Editor; if (drafts_.size() >= 8 && !drafts_.count(snapshot_.session_id)) drafts_.erase(drafts_.begin()); render(); }
        else if (page_ == Page::Editor && editor_) {
            const std::string value = lv_textarea_get_text(editor_); if (value.find_first_not_of(" \t\r\n") == std::string::npos) return;
            drafts_[snapshot_.session_id] = value; submitted_text_ = value; submit("tool.turn.start", {{"text", value}});
        } else if (page_ == Page::Requests && snapshot_.requests_before >= 0) connection_.conversation_read("requests", {{"beforeSeq", snapshot_.requests_before}});
        else if (page_ == Page::Approval && request_current() && !text(selected_, "reviewToken").empty()) {
            if (lv_obj_get_scroll_bottom(content_) > 4 && !read_complete_) { lv_label_set_text(status_, "Read to the end"); return; }
            read_complete_ = true;
            if (!confirm_) { confirm_ = true; lv_label_set_text(right_label_, "Confirm allow"); return; }
            const auto& data = selected_.at("payload").at("data");
            submit("tool.approval.resolve", {{"approvalId", data.at("approvalId")}, {"turnId", data.at("turnId")}, {"decision", "allowOnce"}}, text(selected_, "reviewToken"));
        } else if (page_ == Page::Questions && request_current()) {
            const auto answers = collect_answers();
            if (std::any_of(answers.begin(), answers.end(), [](const Json& values) { return values.empty(); })) { lv_label_set_text(status_, "Answer each question"); return; }
            const auto& data = selected_.at("payload").at("data");
            submitted_request_ = text(data, "requestId"); save_answers();
            submit("tool.user-input.resolve", {{"requestId", data.at("requestId")}, {"turnId", data.at("turnId")}, {"answers", answers}}, text(selected_, "reviewToken"));
        } else if (page_ == Page::NewCommand) { connection_.acknowledge_unknown_command(); snapshot_ = connection_.conversation(); page_ = Page::Editor; render(); }
    }
}
void ConversationScreen::clicked(lv_event_t* event) {
    auto* screen = static_cast<ConversationScreen*>(lv_event_get_user_data(event)); auto* target = lv_event_get_target_obj(event);
    const auto id = target == screen->left_ ? -1 : target == screen->middle_ ? -2 : target == screen->right_ ? -3 : static_cast<int>(reinterpret_cast<intptr_t>(lv_obj_get_user_data(target)));
    screen->action(id);
}
void ConversationScreen::answer_changed(lv_event_t* event) {
    auto* screen = static_cast<ConversationScreen*>(lv_event_get_user_data(event)); auto* target = lv_event_get_target_obj(event);
    const auto field = std::find_if(screen->fields_.begin(), screen->fields_.end(), [&](const AnswerField& item) { return item.object == target; });
    if (field == screen->fields_.end() || field->multiple) return;
    const bool selected = field->custom ? *lv_textarea_get_text(target) != '\0' : lv_obj_has_state(target, LV_STATE_CHECKED);
    if (!selected) return;
    for (const auto& other : screen->fields_) if (other.id == field->id && other.object != target) {
        if (other.custom) { if (*lv_textarea_get_text(other.object)) lv_textarea_set_text(other.object, ""); }
        else lv_obj_remove_state(other.object, LV_STATE_CHECKED);
    }
}
}
