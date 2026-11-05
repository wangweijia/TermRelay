#pragma once
#include "authorization.h"
#include "lvgl.h"

namespace app {
class AuthorizationScreen {
public:
    AuthorizationScreen(connection::Authorization& authorization, bool& running);
    ~AuthorizationScreen();
private:
    void refresh();
    static void action(lv_event_t* event);
    void show_browser();
    void render_browser();
    void back();
    static void browse_action(lv_event_t* event);
    connection::Authorization& authorization_;
    bool& running_;
    lv_obj_t* root_ = nullptr;
    lv_obj_t* origin_ = nullptr;
    lv_obj_t* status_ = nullptr;
    lv_obj_t* message_ = nullptr;
    lv_obj_t* connect_ = nullptr;
    lv_obj_t* connect_label_ = nullptr;
    lv_obj_t* cancel_ = nullptr;
    lv_obj_t* forget_ = nullptr;
    lv_obj_t* forget_label_ = nullptr;
    lv_obj_t* quit_ = nullptr;
    lv_group_t* group_ = nullptr;
    lv_timer_t* timer_ = nullptr;
    bool confirm_forget_ = false;
    enum class Page { Authorization, Devices, Sessions, Detail };
    Page page_ = Page::Authorization;
    lv_obj_t* browser_ = nullptr;
    lv_obj_t* browser_title_ = nullptr;
    lv_obj_t* browser_status_ = nullptr;
    lv_obj_t* browser_list_ = nullptr;
    lv_obj_t* browser_back_ = nullptr;
    lv_obj_t* browser_refresh_ = nullptr;
    lv_obj_t* browser_next_ = nullptr;
    connection::ListingSnapshot displayed_;
    connection::SessionSummary detail_;
    std::string device_id_, device_name_, devices_cursor_, sessions_cursor_;
    std::uint64_t rendered_revision_ = 0;
    bool rendered_loading_ = false;
    bool rendered_online_ = false;
    bool first_browse_ = true;
};
}
