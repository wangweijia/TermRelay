#include "authorization_screen.h"
#include "linux_input.h"
#include <string>

namespace app {
namespace {
const char* title(connection::State state) {
    using connection::State;
    switch (state) {
        case State::Idle: return "Not connected";
        case State::Starting: return "Requesting";
        case State::Waiting: return "Web approval";
        case State::Connecting: return "Connecting";
        case State::Connected: return "Online";
        case State::Retrying: return "Reconnecting";
        case State::Denied: return "Denied";
        case State::Expired: return "Expired";
        case State::Revoked: return "Revoked";
        case State::Error: return "Error";
    }
    return "";
}
void disabled(lv_obj_t* object, bool value) {
    if (value) lv_obj_add_state(object, LV_STATE_DISABLED);
    else lv_obj_remove_state(object, LV_STATE_DISABLED);
}
}
AuthorizationScreen::AuthorizationScreen(connection::Authorization& authorization, bool& running)
    : authorization_(authorization), running_(running) {
    root_ = lv_obj_create(nullptr);
    lv_obj_set_style_pad_all(root_, 0, 0);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    auto* heading = lv_label_create(root_);
    lv_label_set_text(heading, "TermRelay");
    lv_obj_set_pos(heading, 8, 1);
    status_ = lv_label_create(root_);
    lv_obj_set_pos(status_, 130, 1);
    lv_obj_set_size(status_, 182, 20);
    lv_obj_set_style_text_align(status_, LV_TEXT_ALIGN_RIGHT, 0);
    auto* label = lv_label_create(root_);
    lv_label_set_text(label, "Server domain");
    lv_obj_set_pos(label, 8, 23);
    origin_ = lv_textarea_create(root_);
    lv_obj_set_pos(origin_, 8, 45);
    lv_obj_set_size(origin_, 304, 31);
    lv_obj_set_style_pad_ver(origin_, 3, 0);
    lv_textarea_set_one_line(origin_, true);
    lv_textarea_set_max_length(origin_, 253);
    lv_textarea_set_placeholder_text(origin_, "relay.example.com");
    lv_textarea_set_text(origin_, authorization_.snapshot().origin.c_str());
    message_ = lv_label_create(root_);
    lv_obj_set_pos(message_, 8, 82);
    lv_obj_set_size(message_, 304, 60);
    lv_label_set_long_mode(message_, LV_LABEL_LONG_WRAP);
    const auto button = [&](int position, int width, const char* text, lv_obj_t** output_label = nullptr) {
        auto* object = lv_button_create(root_);
        lv_obj_set_pos(object, position, 146);
        lv_obj_set_size(object, width, 24);
        lv_obj_set_style_pad_all(object, 0, 0);
        auto* caption = lv_label_create(object);
        lv_label_set_text(caption, text);
        lv_obj_set_style_text_font(caption, &lv_font_montserrat_12, 0);
        lv_obj_center(caption);
        if (output_label) *output_label = caption;
        lv_obj_add_event_cb(object, action, LV_EVENT_CLICKED, this);
        return object;
    };
    connect_ = button(0, 78, "Connect", &connect_label_);
    cancel_ = button(80, 72, "Cancel");
    forget_ = button(154, 108, "Clear local key", &forget_label_);
    quit_ = button(264, 56, LV_SYMBOL_CLOSE);
    group_ = lv_group_create();
    for (auto* object : {origin_, connect_, cancel_, forget_, quit_}) lv_group_add_obj(group_, object);
    for (auto* input = lv_indev_get_next(nullptr); input; input = lv_indev_get_next(input)) {
        if (lv_indev_get_type(input) == LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input) == LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input, group_);
    }
    browser_ = lv_obj_create(nullptr);
    lv_obj_set_style_pad_all(browser_, 0, 0);
    lv_obj_remove_flag(browser_, LV_OBJ_FLAG_SCROLLABLE);
    browser_title_ = lv_label_create(browser_);
    lv_obj_set_pos(browser_title_, 4, 0);
    lv_obj_set_size(browser_title_, 202, 20);
    lv_label_set_long_mode(browser_title_, LV_LABEL_LONG_CLIP);
    browser_status_ = lv_label_create(browser_);
    lv_obj_set_pos(browser_status_, 208, 0); lv_obj_set_size(browser_status_, 108, 20);
    lv_obj_set_style_text_align(browser_status_, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_style_text_font(browser_status_, &lv_font_montserrat_12, 0);
    browser_list_ = lv_obj_create(browser_);
    lv_obj_set_pos(browser_list_, 0, 20);
    lv_obj_set_size(browser_list_, 320, 126);
    lv_obj_set_style_pad_all(browser_list_, 2, 0);
    lv_obj_set_style_pad_row(browser_list_, 2, 0);
    lv_obj_set_flex_flow(browser_list_, LV_FLEX_FLOW_COLUMN);
    const auto browse_button = [&](int x, int width, const char* text) {
        auto* object = lv_button_create(browser_);
        lv_obj_set_pos(object, x, 146); lv_obj_set_size(object, width, 24);
        lv_obj_set_style_pad_all(object, 0, 0);
        auto* label = lv_label_create(object); lv_label_set_text(label, text); lv_obj_center(label);
        lv_obj_add_event_cb(object, browse_action, LV_EVENT_CLICKED, this);
        return object;
    };
    browser_back_ = browse_button(0, 104, "Back");
    browser_refresh_ = browse_button(108, 104, "Refresh");
    browser_next_ = browse_button(216, 104, "Next page");
    chat_ = std::make_unique<ConversationScreen>(authorization_, [this] {
        page_ = Page::Sessions; lv_screen_load(browser_); render_browser();
    });
    lv_obj_add_event_cb(origin_, +[](lv_event_t* event) {
        auto* screen = static_cast<AuthorizationScreen*>(lv_event_get_user_data(event));
        screen->authorization_.connect(lv_textarea_get_text(screen->origin_));
    }, LV_EVENT_READY, this);
    platform::set_nav_shortcut_mode(false);
    platform::set_global_key_listener(+[](uint32_t key, const char*, bool long_pressed, void* context) -> bool {
        if (key != LV_KEY_ESC) return false;
        auto* screen = static_cast<AuthorizationScreen*>(context);
        if (long_pressed) screen->running_ = false;
        else if (screen->chat_ && screen->chat_->visible()) return screen->chat_->key(key, long_pressed);
        else if (screen->page_ != Page::Authorization) screen->back();
        else { screen->confirm_forget_ = false; screen->authorization_.cancel(); }
        return true;
    }, this);
    timer_ = lv_timer_create(+[](lv_timer_t* timer) { static_cast<AuthorizationScreen*>(lv_timer_get_user_data(timer))->refresh(); }, 100, this);
    lv_screen_load(root_);
    refresh();
}
AuthorizationScreen::~AuthorizationScreen() {
    platform::set_global_key_listener(nullptr, nullptr);
    if (timer_) lv_timer_delete(timer_);
    if (group_) lv_group_delete(group_);
    if (browser_) lv_obj_delete(browser_);
    if (root_) lv_obj_delete(root_);
}
void AuthorizationScreen::action(lv_event_t* event) {
    auto* screen = static_cast<AuthorizationScreen*>(lv_event_get_user_data(event));
    auto* target = lv_event_get_target_obj(event);
    if (target == screen->connect_) {
        screen->confirm_forget_ = false;
        if (screen->authorization_.snapshot().state == connection::State::Connected) screen->show_browser();
        else screen->authorization_.connect(lv_textarea_get_text(screen->origin_));
    }
    else if (target == screen->cancel_) { screen->confirm_forget_ = false; screen->authorization_.cancel(); }
    else if (target == screen->forget_) {
        if (screen->confirm_forget_) { screen->authorization_.forget(); screen->confirm_forget_ = false; }
        else screen->confirm_forget_ = true;
    } else if (target == screen->quit_) screen->running_ = false;
    screen->refresh();
}
void AuthorizationScreen::refresh() {
    const auto snapshot = authorization_.snapshot();
    using connection::State;
    const bool active = snapshot.state == State::Starting || snapshot.state == State::Waiting || snapshot.state == State::Connecting || snapshot.state == State::Connected || snapshot.state == State::Retrying;
    disabled(origin_, active || snapshot.has_credential);
    disabled(connect_, active && snapshot.state != State::Connected);
    lv_label_set_text(connect_label_, snapshot.state == State::Connected ? "Browse" : "Connect");
    disabled(cancel_, !active && !confirm_forget_);
    disabled(forget_, !snapshot.has_credential);
    lv_label_set_text(status_, title(snapshot.state));
    lv_obj_set_style_text_color(status_, snapshot.state == State::Connected ? lv_color_hex(0x43b581) : lv_color_hex(0xe4b955), 0);
    lv_label_set_text(forget_label_, confirm_forget_ ? "Confirm clear" : "Clear local key");
    std::string message = snapshot.message;
    if (confirm_forget_) message = "Clear this local key only?\nWeb authorization stays active.";
    else if (snapshot.state == State::Connected) message = "Permanent authorization\nDevices: " + std::to_string(snapshot.device_count);
    lv_label_set_text(message_, message.c_str());
    if (snapshot.state == State::Revoked || !snapshot.has_credential) {
        if (chat_ && chat_->visible()) chat_->close(true);
        if (page_ != Page::Authorization) {
            page_ = Page::Authorization; lv_screen_load(root_);
            lv_group_remove_all_objs(group_);
            for (auto* object : {origin_, connect_, cancel_, forget_, quit_}) lv_group_add_obj(group_, object);
        }
        displayed_ = {}; detail_ = {}; first_browse_ = true;
    }
    if (first_browse_ && snapshot.state == State::Connected) { first_browse_ = false; show_browser(); }
    if (chat_ && chat_->visible()) { chat_->refresh(); return; }
    if (page_ != Page::Authorization) {
        const auto listing = authorization_.listing();
        const bool online = snapshot.state == State::Connected;
        if (listing.revision != rendered_revision_ || listing.loading != rendered_loading_ || online != rendered_online_) render_browser();
    }
}

void AuthorizationScreen::show_browser() {
    page_ = Page::Devices;
    lv_screen_load(browser_);
    render_browser();
}

void AuthorizationScreen::back() {
    if (page_ == Page::Detail) page_ = Page::Sessions;
    else if (page_ == Page::Sessions) page_ = Page::Devices;
    else {
        page_ = Page::Authorization; lv_screen_load(root_);
        lv_group_remove_all_objs(group_);
        for (auto* object : {origin_, connect_, cancel_, forget_, quit_}) lv_group_add_obj(group_, object);
        return;
    }
    render_browser();
}

void AuthorizationScreen::render_browser() {
    for (auto* input = lv_indev_get_next(nullptr); input; input = lv_indev_get_next(input)) {
        if (lv_indev_get_type(input) == LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input) == LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input, group_);
    }
    displayed_ = authorization_.listing();
    rendered_revision_ = displayed_.revision; rendered_loading_ = displayed_.loading;
    rendered_online_ = authorization_.snapshot().state == connection::State::Connected;
    const std::string title = page_ == Page::Devices ? "Devices" : page_ == Page::Detail ? "Session info" : device_name_;
    lv_label_set_text(browser_title_, title.c_str());
    lv_label_set_text(browser_status_, !rendered_online_ ? "Offline (cache)" : displayed_.loading ? "Loading..."
        : displayed_.error.empty() ? "Online" : "Refresh failed");
    lv_group_remove_all_objs(group_);
    lv_obj_clean(browser_list_);
    const auto label = [&](const std::string& text) {
        auto* object = lv_label_create(browser_list_);
        lv_obj_set_width(object, 300); lv_label_set_long_mode(object, LV_LABEL_LONG_WRAP);
        lv_label_set_text(object, text.c_str());
    };
    const auto row = [&](const std::string& text) {
        auto* object = lv_button_create(browser_list_);
        lv_obj_set_size(object, 300, 44); lv_obj_set_style_pad_all(object, 3, 0);
        auto* caption = lv_label_create(object); lv_obj_set_width(caption, 290);
        lv_label_set_long_mode(caption, LV_LABEL_LONG_DOT); lv_label_set_text(caption, text.c_str());
        lv_obj_set_height(caption, 38);
        lv_obj_add_event_cb(object, browse_action, LV_EVENT_CLICKED, this);
        lv_group_add_obj(group_, object);
    };
    if (page_ == Page::Detail) {
        label((detail_.name.empty() ? detail_.id : detail_.name) + "\nDevice: " + device_name_ + "\n" + detail_.status + " | " + detail_.runtime_mode
            + "\nTool: " + detail_.tool_key + "\nWorkspace: " + detail_.workspace_id + "\nID: " + detail_.id
            + "\nConversation reading is not available yet.");
        // Focus the scrollable container so arrow keys can reveal long metadata.
        lv_group_add_obj(group_, browser_list_);
    } else if (displayed_.loading) label("Loading page...");
    else if (!displayed_.error.empty() && (page_ == Page::Devices ? displayed_.devices.empty()
        : displayed_.device_id != device_id_ || displayed_.sessions.empty())) label(displayed_.error + "\nBack or Refresh to retry.");
    else if (page_ == Page::Devices) {
        for (const auto& device : displayed_.devices) row(device.name + "\n" + device.platform + " | " + device.status);
        if (displayed_.devices.empty()) label("No authorized devices.");
    } else if (displayed_.device_id == device_id_) {
        for (const auto& session : displayed_.sessions) row((session.name.empty() ? session.id : session.name) + "\n" + session.runtime_mode + " | " + session.status);
        if (displayed_.sessions.empty()) label("No sessions on this device.");
    } else label(rendered_online_ ? "Refresh to load sessions." : "No cached page for this device.");
    const auto next = page_ == Page::Devices ? displayed_.next_devices : displayed_.next_sessions;
    disabled(browser_refresh_, !rendered_online_ || displayed_.loading || !displayed_.supported || page_ == Page::Detail);
    disabled(browser_next_, !rendered_online_ || displayed_.loading || !displayed_.supported || !displayed_.error.empty() || next.empty() || page_ == Page::Detail);
    for (auto* object : {browser_back_, browser_refresh_, browser_next_}) lv_group_add_obj(group_, object);
    lv_obj_scroll_to_y(browser_list_, 0, LV_ANIM_OFF);
}

void AuthorizationScreen::browse_action(lv_event_t* event) {
    auto* screen = static_cast<AuthorizationScreen*>(lv_event_get_user_data(event));
    auto* target = lv_event_get_target_obj(event);
    if (target == screen->browser_back_) { screen->back(); return; }
    if (target == screen->browser_refresh_ || target == screen->browser_next_) {
        if (screen->page_ == Page::Devices) {
            screen->devices_cursor_ = target == screen->browser_next_ ? screen->displayed_.next_devices : "";
            screen->authorization_.list_devices(screen->devices_cursor_);
        } else {
            screen->sessions_cursor_ = target == screen->browser_next_ ? screen->displayed_.next_sessions : "";
            screen->authorization_.list_sessions(screen->device_id_, screen->sessions_cursor_);
        }
    } else {
        const auto index = static_cast<std::size_t>(lv_obj_get_index(target));
        if (screen->page_ == Page::Devices && index < screen->displayed_.devices.size()) {
            const auto& device = screen->displayed_.devices[index];
            screen->device_id_ = device.id; screen->device_name_ = device.name; screen->sessions_cursor_.clear();
            screen->page_ = Page::Sessions; screen->authorization_.list_sessions(device.id);
        } else if (screen->page_ == Page::Sessions && index < screen->displayed_.sessions.size()) {
            screen->detail_ = screen->displayed_.sessions[index]; screen->page_ = Page::Detail;
            if (screen->detail_.runtime_mode == "acp" && screen->authorization_.conversation().supported) {
                screen->chat_->open(screen->detail_.id); return;
            }
        }
    }
    screen->render_browser();
}
}
