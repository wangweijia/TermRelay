/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */

#include "theme.h"

#include "ui_const.h"
#include <initializer_list>

namespace view {
namespace {

void compact_controls(lv_theme_t*, lv_obj_t* object) {
    const bool button = lv_obj_check_type(object, &lv_button_class);
    const bool input = lv_obj_check_type(object, &lv_textarea_class);
    if (!button && !input) return;
    // Replace the inherited control styles so default focus animations cannot
    // override the compact palette or leave partially updated highlights.
    lv_obj_remove_style_all(object);
    lv_obj_set_style_pad_all(object, 4, 0);
    lv_obj_set_style_radius(object, 2, 0);
    lv_obj_set_style_shadow_width(object, 0, 0);
    lv_obj_set_style_outline_width(object, 0, 0);
    if (input) {
        lv_obj_set_style_border_color(object, lv_color_hex(0x202428), LV_PART_CURSOR);
        lv_obj_set_style_border_width(object, 1, LV_PART_CURSOR | LV_STATE_FOCUSED);
        lv_obj_set_style_border_side(object, LV_BORDER_SIDE_LEFT, LV_PART_CURSOR);
        lv_obj_set_style_anim_duration(object, 400, LV_PART_CURSOR);
        lv_obj_set_style_text_color(object, lv_color_hex(0x969ca1), LV_PART_TEXTAREA_PLACEHOLDER);
    }
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(object, lv_color_hex(button ? 0xe9ecef : 0xffffff), 0);
    lv_obj_set_style_text_color(object, lv_color_hex(0x202428), 0);
    lv_obj_set_style_border_width(object, 1, 0);
    lv_obj_set_style_border_color(object, lv_color_hex(0x9ba1a6), 0);

    for (const auto state : {LV_STATE_FOCUSED, LV_STATE_FOCUS_KEY, LV_STATE_EDITED, LV_STATE_PRESSED}) {
        lv_obj_set_style_bg_color(object, lv_color_hex(button ? 0x202428 : 0xffffff), state);
        lv_obj_set_style_text_color(object, button ? lv_color_white() : lv_color_hex(0x202428), state);
        lv_obj_set_style_border_width(object, 2, state);
        lv_obj_set_style_border_color(object, lv_color_hex(0x202428), state);
    }
    lv_obj_set_style_bg_color(object, lv_color_hex(0xf1f2f3), LV_STATE_DISABLED);
    lv_obj_set_style_text_color(object, lv_color_hex(0x969ca1), LV_STATE_DISABLED);
    lv_obj_set_style_border_color(object, lv_color_hex(0xd7dadd), LV_STATE_DISABLED);
    lv_obj_set_style_border_width(object, 1, LV_STATE_DISABLED);
    lv_obj_set_style_opa(object, LV_OPA_COVER, LV_STATE_DISABLED);
}

} // namespace

ThemePalette palette(bool dark_mode) {
    if (dark_mode) {
        return {
            lv_color_hex(color::dark::kBody),
            lv_color_hex(color::dark::kCard),
            lv_color_hex(color::dark::kAction),
            lv_color_hex(color::dark::kButton),
            lv_color_hex(color::dark::kBorder),
            lv_color_hex(color::dark::kTextPrimary),
            lv_color_hex(color::dark::kTextDisabled),
            lv_color_hex(color::dark::kPrimary),
            lv_color_hex(color::dark::kInfo),
            lv_color_hex(color::dark::kSuccess),
            lv_color_hex(color::dark::kWarning),
            lv_color_hex(color::dark::kError),
        };
    }

    return {
        lv_color_hex(color::light::kBody),
        lv_color_hex(color::light::kCard),
        lv_color_hex(color::light::kAction),
        lv_color_hex(color::light::kButton),
        lv_color_hex(color::light::kBorder),
        lv_color_hex(color::light::kTextPrimary),
        lv_color_hex(color::light::kTextDisabled),
        lv_color_hex(color::light::kPrimary),
        lv_color_hex(color::light::kInfo),
        lv_color_hex(color::light::kSuccess),
        lv_color_hex(color::light::kWarning),
        lv_color_hex(color::light::kError),
    };
}

void apply_lvgl_theme(lv_display_t* display, bool dark_mode, const lv_font_t* font) {
    if (!display) {
        return;
    }

    const auto colors = palette(dark_mode);
    lv_theme_t* theme = lv_theme_default_init(display, colors.primary, colors.info, dark_mode, font);
    auto* compact = lv_theme_create();
    if (!compact) {
        lv_display_set_theme(display, theme);
        return;
    }
    lv_theme_copy(compact, theme);
    lv_theme_set_parent(compact, theme);
    lv_theme_set_apply_cb(compact, compact_controls);
    lv_display_set_theme(display, compact);
    lv_display_add_event_cb(display, +[](lv_event_t* event) {
        lv_theme_delete(static_cast<lv_theme_t*>(lv_event_get_user_data(event)));
    }, LV_EVENT_DELETE, compact);
}

} // namespace view
