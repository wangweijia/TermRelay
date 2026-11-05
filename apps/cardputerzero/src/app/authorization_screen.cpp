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
    connect_ = button(0, 78, "Connect");
    cancel_ = button(80, 72, "Cancel");
    forget_ = button(154, 108, "Clear local key", &forget_label_);
    quit_ = button(264, 56, LV_SYMBOL_CLOSE);
    group_ = lv_group_create();
    for (auto* object : {origin_, connect_, cancel_, forget_, quit_}) lv_group_add_obj(group_, object);
    for (auto* input = lv_indev_get_next(nullptr); input; input = lv_indev_get_next(input)) {
        if (lv_indev_get_type(input) == LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input) == LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input, group_);
    }
    lv_obj_add_event_cb(origin_, +[](lv_event_t* event) {
        auto* screen = static_cast<AuthorizationScreen*>(lv_event_get_user_data(event));
        screen->authorization_.connect(lv_textarea_get_text(screen->origin_));
    }, LV_EVENT_READY, this);
    platform::set_nav_shortcut_mode(false);
    platform::set_global_key_listener(+[](uint32_t key, const char*, bool long_pressed, void* context) -> bool {
        if (key != LV_KEY_ESC) return false;
        auto* screen = static_cast<AuthorizationScreen*>(context);
        if (long_pressed) screen->running_ = false;
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
    if (root_) lv_obj_delete(root_);
}
void AuthorizationScreen::action(lv_event_t* event) {
    auto* screen = static_cast<AuthorizationScreen*>(lv_event_get_user_data(event));
    auto* target = lv_event_get_target_obj(event);
    if (target == screen->connect_) { screen->confirm_forget_ = false; screen->authorization_.connect(lv_textarea_get_text(screen->origin_)); }
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
    disabled(connect_, active);
    disabled(cancel_, !active && !confirm_forget_);
    disabled(forget_, !snapshot.has_credential);
    lv_label_set_text(status_, title(snapshot.state));
    lv_obj_set_style_text_color(status_, snapshot.state == State::Connected ? lv_color_hex(0x43b581) : lv_color_hex(0xe4b955), 0);
    lv_label_set_text(forget_label_, confirm_forget_ ? "Confirm clear" : "Clear local key");
    std::string message = snapshot.message;
    if (confirm_forget_) message = "Clear this local key only?\nWeb authorization stays active.";
    else if (snapshot.state == State::Connected) message = "Permanent authorization\nDevices: " + std::to_string(snapshot.device_count);
    lv_label_set_text(message_, message.c_str());
}
}