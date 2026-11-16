#include "pinyin_input.h"
#include "linux_input.h"
#include "theme.h"
#include <iostream>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
int main() {
    try {
        lv_init(); auto* display = lv_display_create(320, 170);
        std::vector<uint32_t> pixels(320 * 32);
        lv_display_set_buffers(display, pixels.data(), nullptr, pixels.size() * 4, LV_DISPLAY_RENDER_MODE_PARTIAL);
        lv_display_set_flush_cb(display, +[](lv_display_t* d, const lv_area_t*, uint8_t*) { lv_display_flush_ready(d); });
        view::apply_lvgl_theme(display, false);
        auto* root = lv_obj_create(nullptr); lv_obj_set_style_pad_all(root, 0, 0); lv_screen_load(root);
        auto* field = lv_textarea_create(root); lv_obj_set_pos(field, 0, 20); lv_obj_set_size(field, 320, 78);
        auto* footer = lv_button_create(root); lv_obj_set_pos(footer, 0, 146); lv_obj_set_size(footer, 100, 24);
        auto* group = lv_group_create(); lv_group_add_obj(group, field); lv_group_add_obj(group, footer);
        lv_indev_data_t data{};
        auto* input = lv_indev_create(); lv_indev_set_type(input, LV_INDEV_TYPE_KEYPAD);
        lv_indev_set_user_data(input, &data);
        lv_indev_set_read_cb(input, +[](lv_indev_t* i, lv_indev_data_t* d) { *d = *static_cast<lv_indev_data_t*>(lv_indev_get_user_data(i)); });
        platform::bind_key_group(group);
        const auto press = [&](uint32_t key) {
            data.key = key; data.state = LV_INDEV_STATE_PRESSED; lv_tick_inc(20); lv_indev_read(input);
            data.state = LV_INDEV_STATE_RELEASED; lv_tick_inc(20); lv_indev_read(input);
            lv_obj_update_layout(root);
        };
        const auto type = [&](const std::string& value) { for (const auto ch : value) press(static_cast<unsigned char>(ch)); };
        {
            app::PinyinInput ime(root, [] {}); ime.attach(field);
            type("fxzc"); require(std::string(lv_textarea_get_text(field)) == "fxzc", "English mode must preserve navigation letters");
            require(platform::map_keyboard_key(57, false, true) == platform::kKeyInputMode, "Ctrl+Space must map to input-mode switching");
#if !defined(_WIN32)
            const auto* temporary = std::getenv("TMPDIR");
            const std::string saved_temporary = temporary ? temporary : "";
            const bool had_temporary = temporary != nullptr;
            setenv("TMPDIR", "/tmp/termrelay-missing-android-temp-path", 1);
#endif
            press(platform::kKeyInputMode);
#if !defined(_WIN32)
            if (had_temporary) setenv("TMPDIR", saved_temporary.c_str(), 1); else unsetenv("TMPDIR");
#endif
#if !USE_DESKTOP
            require(ime.available(), "Device/container tests require the offline pinyin runtime and dictionary");
#endif
            if (ime.available()) {
                require(ime.enabled(), "Ctrl+Space must enable pinyin");
                lv_textarea_set_text(field, ""); type("nihao");
                require(ime.composing() && std::string(lv_textarea_get_text(field)).empty(), "Unconfirmed pinyin must not enter the message");
                press(' '); require(std::string(lv_textarea_get_text(field)) == "你好" && !ime.composing(), "Space must commit the Chinese phrase nihao");
                press(LV_KEY_BACKSPACE); require(std::string(lv_textarea_get_text(field)) == "你", "Backspace must remove one Chinese character");
                press(LV_KEY_BACKSPACE); type("zhongwen"); press('1');
                require(std::string(lv_textarea_get_text(field)) == "中文", "Number keys must select phrase candidates");
                type("ceshi"); press(LV_KEY_BACKSPACE); press('i'); press(' ');
                require(std::string(lv_textarea_get_text(field)) == "中文测试", "Spelling correction must retain earlier Chinese text");
                type("shi");
                auto* panel = lv_obj_get_child(root, -1); auto* candidate = lv_obj_get_child(panel, 1);
                const std::string first = lv_label_get_text(candidate); press('=');
                require(std::string(lv_label_get_text(candidate)) != first, "Candidate paging must advance");
                press('-'); require(std::string(lv_label_get_text(candidate)) == first, "Candidate paging must return");
                press(LV_KEY_ESC); require(!ime.composing() && std::string(lv_textarea_get_text(field)) == "中文测试", "Esc must cancel only the composition");
                type("nihao"); press('2'); if (ime.composing()) press(' ');
                require(!ime.composing(), "Partial selections must finish the remaining syllables");
                type("abc"); press(platform::kKeyInputMode);
                require(!ime.enabled() && (std::string(lv_textarea_get_text(field)).rfind("abc") == std::string(lv_textarea_get_text(field)).size() - 3), "Switching to English must preserve literal composition");
                type("fxzc"); require((std::string(lv_textarea_get_text(field)).rfind("abcfxzc") == std::string(lv_textarea_get_text(field)).size() - 7), "Switching back must restore English typing");
                press(platform::kKeyInputMode); lv_textarea_set_text(field, ""); type("nihao"); press(LV_KEY_NEXT);
                require(lv_group_get_focused(group) == footer && std::string(lv_textarea_get_text(field)) == "你好", "Tab must commit preedit and leave the text field");
                lv_group_focus_obj(field); type("zhongwen"); ime.clear_inputs();
                require(!ime.composing(), "Page cleanup must cancel uncommitted spelling");
            }
        }
        lv_indev_delete(input); lv_group_delete(group); lv_display_delete(display); lv_deinit();
        std::cout << "Pinyin phrases, candidate paging, Chinese deletion, English toggle and focus checks passed\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
