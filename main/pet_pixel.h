#pragma once
/* Pixel-art pet: frames are character grids drawn by main.c as run-length
 * rectangles at any integer scale (4x on the overview, 8x in desk mode), so
 * a whole animated pet costs a few KB of Flash and no image buffers.
 * Cells: '.' transparent, 'a'..'h' palette[0..7] as 0xAARRGGBB (alpha softens edges).
 * The scale is the target width divided by `w` (112 px overview, 224 px desk). */
#include <stdint.h>

enum {
    PET_PIXEL_REST, PET_PIXEL_TAIL_UP, PET_PIXEL_TAIL_DOWN, PET_PIXEL_BLINK,
    PET_PIXEL_HAPPY, PET_PIXEL_ALERT, PET_PIXEL_SQUASH, PET_PIXEL_FRAMES
};
typedef struct {
    uint8_t w, h;
    uint32_t palette[8];   /* 0xAARRGGBB */
    const char *frames[PET_PIXEL_FRAMES];
    int8_t emit_x, emit_y;  /* where bubbles leave, in cells */
} pet_pixel_sprite_t;
