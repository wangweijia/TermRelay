#pragma once
#include "lvgl.h"
#include <array>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace app {
// One decoder on the UI thread, shared by the text fields on the current page.
class PinyinInput {
public:
    PinyinInput(lv_obj_t* parent, std::function<void()> changed);
    ~PinyinInput();
    void attach(lv_obj_t* textarea);
    void clear_inputs();
    bool toggle();
    bool cancel();
    bool enabled() const { return enabled_; }
    bool composing() const { return !spelling_.empty(); }
    bool available() const;
private:
    struct Engine;
    static void event(lv_event_t* event);
    bool key(uint32_t key);
    void search();
    void choose(size_t index);
    void commit(std::string value);
    void update();
    std::unique_ptr<Engine> engine_;
    lv_obj_t *panel_, *spelling_label_, *target_ = nullptr;
    std::array<lv_obj_t*, 3> candidates_{};
    std::vector<lv_obj_t*> inputs_;
    std::function<void()> changed_;
    std::string spelling_;
    size_t count_ = 0, page_ = 0;
    bool enabled_ = false;
};
}
