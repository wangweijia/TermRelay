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
    connection::Authorization& authorization_;
    bool& running_;
    lv_obj_t* root_ = nullptr;
    lv_obj_t* origin_ = nullptr;
    lv_obj_t* status_ = nullptr;
    lv_obj_t* message_ = nullptr;
    lv_obj_t* connect_ = nullptr;
    lv_obj_t* cancel_ = nullptr;
    lv_obj_t* forget_ = nullptr;
    lv_obj_t* forget_label_ = nullptr;
    lv_obj_t* quit_ = nullptr;
    lv_group_t* group_ = nullptr;
    lv_timer_t* timer_ = nullptr;
    bool confirm_forget_ = false;
};
}