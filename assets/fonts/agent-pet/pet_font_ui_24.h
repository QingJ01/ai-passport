/* Noto Sans SC derivative bitmap font; SIL OFL 1.1, see OFL.txt. */
#ifndef PET_FONT_UI_24_H
#define PET_FONT_UI_24_H

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 24 px em, weight 600; UI copy subset + printable ASCII; see coverage-ui.txt.
 * Static Flash data, no initialization/allocation required. Font metrics are
 * exported by LVGL (line_height/base_line); do not assume a 24 px line pitch.
 */
LV_FONT_DECLARE(pet_font_ui_24)

#ifdef __cplusplus
}
#endif
#endif
