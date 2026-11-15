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
        press('r');
        require(std::string(lv_textarea_get_text(origin)) == "r", "The initial server field must accept text");
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

        lv_indev_delete(input);
        lv_group_delete(group); lv_group_delete(other);
        lv_display_delete(display); lv_deinit();
        std::cout << "Keyboard focus, Tab, Shift+Tab and text entry checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
