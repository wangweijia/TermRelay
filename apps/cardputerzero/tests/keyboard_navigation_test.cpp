#include "linux_input.h"
#include "theme.h"
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
struct Key {
    uint32_t code = 0;
    lv_indev_state_t state = LV_INDEV_STATE_RELEASED;
};
struct Framebuffer {
    std::vector<uint32_t> pixels = std::vector<uint32_t>(320 * 170);
};
}

int main() {
    try {
        lv_init();
        auto* display = lv_display_create(320, 170);
        Framebuffer framebuffer;
        lv_display_set_user_data(display, &framebuffer);
        lv_display_set_color_format(display, LV_COLOR_FORMAT_XRGB8888);
        std::vector<uint32_t> pixels(320 * 32);
        lv_display_set_buffers(display, pixels.data(), nullptr, pixels.size() * sizeof(uint32_t), LV_DISPLAY_RENDER_MODE_PARTIAL);
        lv_display_set_flush_cb(display, +[](lv_display_t* target, const lv_area_t* area, uint8_t* bytes) {
            auto& frame = *static_cast<Framebuffer*>(lv_display_get_user_data(target));
            const auto stride = lv_draw_buf_width_to_stride(lv_area_get_width(area), LV_COLOR_FORMAT_XRGB8888);
            for (int y = area->y1; y <= area->y2; ++y) {
                const auto* row = reinterpret_cast<const uint32_t*>(bytes + (y - area->y1) * stride);
                for (int x = area->x1; x <= area->x2; ++x) frame.pixels[y * 320 + x] = row[x - area->x1];
            }
            lv_display_flush_ready(target);
        });
        view::apply_lvgl_theme(display, false);
        auto* root = lv_obj_create(nullptr);
        lv_obj_set_style_pad_all(root, 0, 0);
        lv_screen_load(root);
        auto* origin = lv_textarea_create(root);
        lv_obj_set_pos(origin, 4, 4); lv_obj_set_size(origin, 312, 32);
        auto* browse = lv_button_create(root);
        auto* cancel = lv_button_create(root);
        auto* reset = lv_button_create(root);
        auto* exit = lv_button_create(root);
        int x = 4;
        for (auto* object : {browse, cancel, reset, exit}) {
            lv_obj_set_pos(object, x, 48); lv_obj_set_size(object, 72, 24); x += 80;
        }
        auto* group = lv_group_create();
        auto* other = lv_group_create();
        Key key;
        auto* input = lv_indev_create();
        lv_indev_set_type(input, LV_INDEV_TYPE_KEYPAD);
        lv_indev_set_user_data(input, &key);
        lv_indev_set_read_cb(input, +[](lv_indev_t* source, lv_indev_data_t* data) {
            const auto& event = *static_cast<Key*>(lv_indev_get_user_data(source));
            data->key = event.code; data->state = event.state; data->continue_reading = false;
        });
        const auto press = [&](uint32_t code) {
            // State transitions follow a real render, as they do on the device.
            lv_refr_now(display);
            key = {code, LV_INDEV_STATE_PRESSED}; lv_tick_inc(20); lv_indev_read(input);
            key.state = LV_INDEV_STATE_RELEASED; lv_tick_inc(20); lv_indev_read(input);
        };

        // Returning from the browser adds the locked server field first. LVGL
        // leaves the entire group without focus unless it is explicitly repaired.
        lv_obj_add_state(origin, LV_STATE_DISABLED);
        for (auto* object : {origin, browse, cancel, reset, exit}) lv_group_add_obj(group, object);
        lv_indev_set_group(input, other);
        platform::bind_key_group(group);
        require(lv_indev_get_group(input) == group, "Returning to a page must restore its keyboard group");
        require(lv_group_get_focused(group) == browse, "A locked first field must not trap Tab navigation");
        const auto require_highlight = [&](lv_obj_t* selected) {
            lv_refr_now(display);
            for (auto* object : {browse, cancel, reset, exit}) {
                lv_area_t area;
                lv_obj_get_coords(object, &area);
                const auto color = framebuffer.pixels[(area.y1 + 6) * 320 + area.x1 + 6] & 0xffffff;
                if (color != (object == selected ? 0x202428u : 0xe9ecefu)) {
                    std::cerr << "Button x=" << area.x1 << " selected=" << (object == selected)
                              << " pixel=0x" << std::hex << color << std::dec << '\n';
                }
                require(color == (object == selected ? 0x202428u : 0xe9ecefu),
                        "Partial rendering must show exactly one complete button highlight");
            }
        };
        require_highlight(browse);
        for (auto* expected : {cancel, reset, exit, browse}) {
            press(platform::map_keyboard_key(15, false));
            require(lv_group_get_focused(group) == expected, "Tab must cycle enabled controls");
            require_highlight(expected);
        }
        press(platform::map_keyboard_key(15, true));
        require(lv_group_get_focused(group) == exit, "Shift+Tab must wrap backwards");
        require_highlight(exit);
        platform::bind_key_group(group);
        require(lv_group_get_focused(group) == exit, "Refreshing a page must preserve valid focus");

        lv_group_remove_all_objs(group);
        lv_obj_remove_state(origin, LV_STATE_DISABLED);
        lv_obj_add_state(cancel, LV_STATE_DISABLED);
        lv_obj_add_state(reset, LV_STATE_DISABLED);
        for (auto* object : {origin, browse, cancel, reset, exit}) lv_group_add_obj(group, object);
        platform::bind_key_group(group);
        for (auto letter : std::string("rfxzcFXZC")) press(letter);
        require(std::string(lv_textarea_get_text(origin)) == "rfxzcFXZC", "The initial server field must accept text");
        press(LV_KEY_NEXT);
        require(lv_group_get_focused(group) == browse, "Tab must leave the text field");
        press(LV_KEY_NEXT);
        require(lv_group_get_focused(group) == exit, "Tab must skip unavailable actions");
        for (auto* object : {origin, browse, exit}) lv_obj_add_state(object, LV_STATE_DISABLED);
        lv_group_remove_all_objs(group);
        for (auto* object : {origin, browse, exit}) lv_group_add_obj(group, object);
        platform::bind_key_group(group);
        lv_obj_remove_state(browse, LV_STATE_DISABLED);
        platform::bind_key_group(group);
        require(lv_group_get_focused(group) == browse, "Focus must recover when an action becomes available");

        // Spatial navigation follows the layout, skips unavailable actions and
        // never activates them. Text editing remains literal, including arrows.
        for (auto* object : {origin, browse, cancel, reset, exit}) lv_obj_remove_state(object, LV_STATE_DISABLED);
        lv_group_remove_all_objs(group);
        for (auto* object : {origin, browse, cancel, reset, exit}) lv_group_add_obj(group, object);
        platform::bind_key_group(group);
        lv_group_focus_obj(browse);
        int clicks = 0;
        lv_obj_add_event_cb(cancel, +[](lv_event_t* e) { ++*static_cast<int*>(lv_event_get_user_data(e)); }, LV_EVENT_CLICKED, &clicks);
        press('c'); require(lv_group_get_focused(group) == cancel, "C must move right"); require_highlight(cancel);
        press('Z'); require(lv_group_get_focused(group) == browse, "Z must move left");
        press('f'); require(lv_group_get_focused(group) == origin, "F must move up into the server field");
        press('x'); require(std::string(lv_textarea_get_text(origin)) == "rfxzcFXZCx", "X in a text field must remain text");
        press(LV_KEY_LEFT); press('c');
        require(std::string(lv_textarea_get_text(origin)) == "rfxzcFXZCcx", "Arrows must retain cursor editing inside text fields");
        press(LV_KEY_NEXT);
        lv_obj_add_state(cancel, LV_STATE_DISABLED);
        press('C'); require(lv_group_get_focused(group) == reset, "Directions must skip disabled buttons");
        require(clicks == 0, "Direction keys must never activate buttons");

        // A scrollable list must traverse rows beyond the viewport before the
        // footer, and checkboxes must only change when Enter is pressed.
        lv_group_remove_all_objs(group); lv_obj_clean(root);
        auto* list = lv_obj_create(root); lv_obj_set_pos(list, 0, 0); lv_obj_set_size(list, 320, 126);
        lv_obj_set_style_pad_all(list, 0, 0); lv_obj_set_style_border_width(list, 0, 0);
        auto* first = lv_checkbox_create(list); lv_obj_set_pos(first, 4, 0); lv_checkbox_set_text(first, "First");
        auto* second = lv_button_create(list); lv_obj_set_pos(second, 4, 50); lv_obj_set_size(second, 290, 40);
        auto* third = lv_button_create(list); lv_obj_set_pos(third, 4, 150); lv_obj_set_size(third, 290, 40);
        auto* footer = lv_button_create(root); lv_obj_set_pos(footer, 4, 146); lv_obj_set_size(footer, 100, 24);
        for (auto* object : {first, second, third, footer}) lv_group_add_obj(group, object);
        platform::bind_key_group(group);
        press('x'); require(lv_group_get_focused(group) == second, "X must move down the list");
        require(!lv_obj_has_state(first, LV_STATE_CHECKED), "Navigation must not change a checkbox answer");
        press(LV_KEY_DOWN); require(lv_group_get_focused(group) == third, "Down must reach an off-screen row before the footer");
        require(lv_obj_get_scroll_y(list) > 0, "Off-screen focus must scroll into view");
        press('x'); require(lv_group_get_focused(group) == footer, "Down from the final row must reach the footer");
        lv_group_focus_obj(first); press(LV_KEY_ENTER);
        require(lv_obj_has_state(first, LV_STATE_CHECKED), "Enter must still select a checkbox");
        auto* details = lv_obj_create(root); lv_obj_set_pos(details, 0, 0); lv_obj_set_size(details, 320, 126);
        auto* long_text = lv_label_create(details); lv_obj_set_size(long_text, 280, 500); lv_label_set_text(long_text, "Long details");
        lv_group_remove_all_objs(group); lv_group_add_obj(group, details); lv_group_add_obj(group, footer);
        platform::bind_key_group(group);
        press('x'); require(lv_obj_get_scroll_y(details) > 0, "X must scroll focused long content");
        press('f'); require(lv_obj_get_scroll_y(details) == 0, "F must scroll long content back up");
        lv_obj_scroll_to_y(details, LV_COORD_MAX, LV_ANIM_OFF);
        press('x'); require(lv_group_get_focused(group) == footer, "Down at the end of content must leave for the footer");

        // A message taller than the viewport scrolls without losing focus.
        lv_group_remove_all_objs(group); lv_obj_clean(root);
        auto* transcript = lv_obj_create(root); lv_obj_set_pos(transcript, 0, 0); lv_obj_set_size(transcript, 320, 126);
        lv_obj_set_style_pad_all(transcript, 0, 0);
        auto* message = lv_button_create(transcript); lv_obj_set_pos(message, 0, 0); lv_obj_set_size(message, 290, 400);
        auto* next_message = lv_button_create(transcript); lv_obj_set_pos(next_message, 0, 410); lv_obj_set_size(next_message, 290, 40);
        lv_group_add_obj(group, message); lv_group_add_obj(group, next_message); platform::bind_key_group(group);
        // Refreshing a group must not accumulate key handlers.
        const auto handlers = lv_obj_get_event_count(message);
        platform::bind_key_group(group);
        require(lv_obj_get_event_count(message) == handlers, "Refreshing must not duplicate direction handlers");
        lv_obj_scroll_to_y(transcript, 0, LV_ANIM_OFF);
        press('x');
        require(lv_group_get_focused(group) == message && lv_obj_get_scroll_y(transcript) > 0,
                "Down must read a tall message before moving to the next one");
        press('f'); require(lv_obj_get_scroll_y(transcript) == 0, "Up must read back toward the start of a tall message");

        lv_indev_delete(input);
        lv_group_delete(group); lv_group_delete(other);
        lv_display_delete(display); lv_deinit();
        std::cout << "Keyboard focus, directional navigation, scrolling, checkbox safety and text entry checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
