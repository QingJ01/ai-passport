/* Noto Sans SC derivative bitmap font; SIL OFL 1.1, see OFL.txt. */
#ifndef PET_FONT_CJK_16_H
#define PET_FONT_CJK_16_H

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 16 px em, GB2312 + printable ASCII; see coverage.txt.
 * Static Flash data, no initialization/allocation required. Font metrics are
 * exported by LVGL (line_height/base_line); do not assume a 16 px line pitch.
 */
LV_FONT_DECLARE(pet_font_cjk_16)

#ifdef __cplusplus
}
#endif
#endif
