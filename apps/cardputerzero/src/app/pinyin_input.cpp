#include "pinyin_input.h"
#include "linux_input.h"
#include <algorithm>
#include <cstdint>
#include <filesystem>
#if !defined(_WIN32)
#include <dlfcn.h>
#include <unistd.h>
#endif

namespace app {
struct PinyinInput::Engine {
    void* library = nullptr;
    bool opened = false;
    std::string directory;
    bool (*open)(const char*, const char*) = nullptr;
    void (*close)() = nullptr;
    void (*reset)() = nullptr;
    void (*limits)(size_t, size_t) = nullptr;
    size_t (*search)(const char*, size_t) = nullptr;
    uint16_t* (*candidate)(size_t, uint16_t*, size_t) = nullptr;
    size_t (*choose)(size_t) = nullptr;
    size_t (*fixed)() = nullptr;
    size_t (*segments)(const uint16_t*&) = nullptr;
    const char* (*spelling)(size_t*) = nullptr;
    Engine() {
#if !defined(_WIN32)
        library = dlopen("libgooglepinyin.so.0", RTLD_NOW | RTLD_LOCAL);
        if (!library) return;
#define LOAD(member, symbol) member = reinterpret_cast<decltype(member)>(dlsym(library, symbol)); if (!member) return
        LOAD(open, "im_open_decoder"); LOAD(close, "im_close_decoder");
        LOAD(reset, "im_reset_search"); LOAD(limits, "im_set_max_lens");
        LOAD(search, "im_search"); LOAD(candidate, "im_get_candidate");
        LOAD(choose, "im_choose"); LOAD(fixed, "im_get_fixed_len");
        LOAD(segments, "im_get_spl_start_pos"); LOAD(spelling, "im_get_sps_str");
#undef LOAD
        // Private, ephemeral user dictionary: typed content stays on the device
        // and is not added to persistent app state or a shared temporary file.
        std::error_code error;
        auto temporary = std::filesystem::temp_directory_path(error);
        // ADB may inherit an Android TMPDIR that does not exist on Debian.
        if (error) temporary = "/tmp";
        auto pattern = (temporary / "termrelay-pinyin-XXXXXX").string();
        if (!mkdtemp(pattern.data())) return;
        directory = pattern;
        for (const auto* dictionary : {"/usr/lib/aarch64-linux-gnu/googlepinyin/data/dict_pinyin.dat",
                                      "/usr/lib/x86_64-linux-gnu/googlepinyin/data/dict_pinyin.dat",
                                      "/usr/share/googlepinyin/data/dict_pinyin.dat"}) {
            if (!std::filesystem::exists(dictionary, error)) continue;
            opened = open(dictionary, (directory + "/user.dict").c_str());
            if (opened) { limits(63, 32); break; }
        }
#endif
    }
    ~Engine() {
#if !defined(_WIN32)
        if (opened) close();
        if (library) dlclose(library);
        if (!directory.empty()) { std::error_code error; std::filesystem::remove_all(directory, error); }
#endif
    }
    std::string text(size_t index) const {
        uint16_t buffer[128]{};
        if (!opened || !candidate(index, buffer, 128)) return "";
        std::string result;
        for (size_t i = 0; i < 127 && buffer[i]; ++i) {
            uint32_t cp = buffer[i];
            if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < 127 && buffer[i + 1] >= 0xdc00 && buffer[i + 1] <= 0xdfff)
                cp = 0x10000 + ((cp - 0xd800) << 10) + (buffer[++i] - 0xdc00);
            if (cp < 0x80) result += static_cast<char>(cp);
            else if (cp < 0x800) { result += static_cast<char>(0xc0 | (cp >> 6)); result += static_cast<char>(0x80 | (cp & 63)); }
            else if (cp < 0x10000) { result += static_cast<char>(0xe0 | (cp >> 12)); result += static_cast<char>(0x80 | ((cp >> 6) & 63)); result += static_cast<char>(0x80 | (cp & 63)); }
            else { result += static_cast<char>(0xf0 | (cp >> 18)); result += static_cast<char>(0x80 | ((cp >> 12) & 63)); result += static_cast<char>(0x80 | ((cp >> 6) & 63)); result += static_cast<char>(0x80 | (cp & 63)); }
        }
        return result;
    }
};

PinyinInput::PinyinInput(lv_obj_t* parent, std::function<void()> changed) : changed_(std::move(changed)) {
    panel_ = lv_obj_create(parent); lv_obj_set_pos(panel_, 0, 98); lv_obj_set_size(panel_, 320, 48);
    lv_obj_set_style_pad_all(panel_, 2, 0); lv_obj_set_style_border_width(panel_, 0, 0);
    lv_obj_set_style_radius(panel_, 0, 0); lv_obj_remove_flag(panel_, LV_OBJ_FLAG_SCROLLABLE);
    spelling_label_ = lv_label_create(panel_); lv_obj_set_pos(spelling_label_, 0, 0); lv_obj_set_size(spelling_label_, 314, 19);
    lv_label_set_long_mode(spelling_label_, LV_LABEL_LONG_DOT);
    for (size_t i = 0; i < candidates_.size(); ++i) {
        auto* label = candidates_[i] = lv_label_create(panel_);
        lv_obj_set_pos(label, i * 106, 22); lv_obj_set_size(label, 104, 22); lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    }
    lv_obj_add_flag(panel_, LV_OBJ_FLAG_HIDDEN);
}
PinyinInput::~PinyinInput() { clear_inputs(); lv_obj_delete(panel_); }
bool PinyinInput::available() const { return engine_ && engine_->opened; }
void PinyinInput::attach(lv_obj_t* textarea) {
    inputs_.push_back(textarea);
    lv_obj_add_event_cb(textarea, event, static_cast<lv_event_code_t>(LV_EVENT_ALL | LV_EVENT_PREPROCESS), this);
    if (lv_obj_has_state(textarea, LV_STATE_FOCUSED)) target_ = textarea;
    update();
}
void PinyinInput::clear_inputs() {
    for (auto* input : inputs_) if (lv_obj_is_valid(input)) lv_obj_remove_event_cb_with_user_data(input, event, this);
    inputs_.clear(); target_ = nullptr; spelling_.clear(); count_ = page_ = 0;
    if (available()) engine_->reset();
    lv_obj_add_flag(panel_, LV_OBJ_FLAG_HIDDEN);
}
bool PinyinInput::toggle() {
    // Never allow an initialization exception to unwind through LVGL's C event
    // stack; leaving that stack half-populated corrupts subsequent UI teardown.
    if (!engine_) {
        try { engine_ = std::make_unique<Engine>(); }
        catch (const std::exception&) { return false; }
    }
    if (!available()) return false;
    if (composing()) commit(spelling_);
    enabled_ = !enabled_;
    if (target_ && lv_obj_is_valid(target_)) lv_group_focus_obj(target_);
    update(); return true;
}
bool PinyinInput::cancel() {
    if (!composing()) return false;
    spelling_.clear(); count_ = page_ = 0;
    if (available()) engine_->reset();
    update(); return true;
}
void PinyinInput::commit(std::string value) {
    // Clear composition before VALUE_CHANGED so send validation sees committed text.
    spelling_.clear(); count_ = page_ = 0; engine_->reset();
    if (target_ && !lv_obj_has_state(target_, LV_STATE_DISABLED)) lv_textarea_add_text(target_, value.c_str());
    update();
}
void PinyinInput::search() {
    page_ = 0;
    count_ = spelling_.empty() ? 0 : engine_->search(spelling_.c_str(), spelling_.size());
    size_t decoded = 0;
    if (count_) {
        const auto* accepted = engine_->spelling(&decoded);
        if (!accepted || std::string(accepted) != spelling_ || decoded != spelling_.size()) count_ = 0;
    }
    update();
}
void PinyinInput::choose(size_t index) {
    if (index >= count_) return;
    count_ = engine_->choose(index); page_ = 0;
    const uint16_t* starts = nullptr;
    if (count_ == 1 && engine_->fixed() == engine_->segments(starts)) {
        const auto value = engine_->text(0); if (!value.empty()) { commit(value); return; }
    }
    update();
}
bool PinyinInput::key(uint32_t key) {
    if (key == platform::kKeyInputMode) { toggle(); return true; }
    if (!enabled_ || !available()) return false;
    if ((key >= 'a' && key <= 'z') || (key == '\'' && composing())) {
        if (spelling_.size() < 63) { spelling_ += static_cast<char>(key); search(); }
        return true;
    }
    if (!composing()) return false;
    if (key == LV_KEY_BACKSPACE) { spelling_.pop_back(); engine_->reset(); search(); return true; }
    if (key == LV_KEY_ESC) { cancel(); return true; }
    if (key >= '1' && key <= '3') { choose(page_ * 3 + key - '1'); return true; }
    if (key == '-' || key == LV_KEY_LEFT) { if (page_) --page_; update(); return true; }
    if (key == '=' || key == LV_KEY_RIGHT) { if ((page_ + 1) * 3 < count_) ++page_; update(); return true; }
    if (key == ' ') { choose(page_ * 3); return true; }
    if (key == LV_KEY_ENTER) { if (count_) choose(0); else commit(spelling_); return true; }
    // Punctuation/uppercase/numbers after a composition retain literal input.
    // Confirm a full best candidate first; Enter can retain unrecognized letters.
    if (key >= 32 && key <= 126) { if (count_) choose(0); else commit(spelling_); return false; }
    return false;
}
void PinyinInput::update() {
    const bool visible = enabled_ && target_ && lv_obj_is_valid(target_) && lv_obj_has_state(target_, LV_STATE_FOCUSED);
    if (visible) lv_obj_remove_flag(panel_, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(panel_, LV_OBJ_FLAG_HIDDEN);
    std::string hint = spelling_.empty() ? "Pinyin  Space/1-3: select  -/=: page" : spelling_ + "  " + std::to_string(page_ + 1) + "/" + std::to_string(std::max(size_t(1), (count_ + 2) / 3));
    if (!spelling_.empty() && !count_) hint = spelling_ + "  Enter: letters";
    lv_label_set_text(spelling_label_, hint.c_str());
    for (size_t i = 0; i < candidates_.size(); ++i) {
        const auto index = page_ * 3 + i;
        const auto value = index < count_ ? std::to_string(i + 1) + " " + engine_->text(index) : "";
        lv_label_set_text(candidates_[i], value.c_str());
    }
    if (changed_) changed_();
}
void PinyinInput::event(lv_event_t* event) {
    auto* self = static_cast<PinyinInput*>(lv_event_get_user_data(event));
    auto* input = lv_event_get_current_target_obj(event);
    const auto code = lv_event_get_code(event);
    if (code == LV_EVENT_FOCUSED) { self->target_ = input; self->update(); }
    else if (code == LV_EVENT_DEFOCUSED) {
        // Tab changes focus in LVGL before dispatching a widget key event.
        if (self->target_ == input && self->composing()) { if (self->count_) self->choose(0); else self->commit(self->spelling_); }
        lv_obj_add_flag(self->panel_, LV_OBJ_FLAG_HIDDEN);
    } else if (code == LV_EVENT_KEY && !lv_obj_has_state(input, LV_STATE_DISABLED)) {
        self->target_ = input;
        if (self->key(lv_event_get_key(event))) lv_event_stop_processing(event);
    } else if (code == LV_EVENT_DELETE) {
        self->inputs_.erase(std::remove(self->inputs_.begin(), self->inputs_.end(), input), self->inputs_.end());
        if (self->target_ == input) { self->target_ = nullptr; self->spelling_.clear(); self->count_ = 0; }
    }
}
}
