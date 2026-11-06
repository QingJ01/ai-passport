/* Agent Pet: original pets in two themes and a bounded four-page companion UI.
 * All on-screen copy is Simplified Chinese. Fixed copy uses the UI subset
 * fonts (14/24 px); dynamic task text uses the GB2312 16 px font. */
#include "bsp_i2c.h"
#include "bsp_display.h"
#include "bsp_button.h"
#include "bsp_battery.h"
#include "bsp_pins.h"
#include "agent_pet_runtime.h"
#include "agent_pet_provisioning.h"
#include "agent_pet_input.h"
#include "agent_pet_text.h"
#include "agent_pet_mood.h"
#include "pet_font_cjk_16.h"
#include "pet_font_ui_14.h"
#include "pet_font_ui_24.h"
#include "pet_font_num_40.h"
#include "pet_whale_img.h"
#include "pet_critter_img.h"
#include "pet_pixel.h"
#include "key_guard.h"
#include "lvgl.h"
#include "esp_timer.h"
#include "esp_sleep.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>


typedef struct { bsp_btn_t button; bsp_btn_ev_t event; } input_t;
static QueueHandle_t keys;
static key_guard_t guard;
static lv_obj_t *screen,*heading,*health,*battery,*body,*footer,*whale,*eye,*pupil,*eye2,*pupil2,*splash,*qr,*body_panel;
static lv_obj_t *hero,*hero_primary,*hero_secondary,*section,*status_dot,*menu_focus,*nav_mark,*nav_bg;
/* Shared list rows (tasks, models, inbox) inside body_panel, and three stat tiles. */
#define LIST_ROWS 4
#define USAGE_ROWS 3
static lv_obj_t *list_title[LIST_ROWS],*list_sub[LIST_ROWS],*list_value[LIST_ROWS];
static lv_obj_t *tile[3],*tile_label[3],*tile_value[3];
static unsigned usage_page;
#define ROW_COUNT 5
static lv_obj_t *nav[4],*rows[ROW_COUNT];
static char qr_payload[1024],shown_qr[1024];
static pet_runtime_view_t view;
static pet_action_view_t action_view;
static unsigned page_index,selected,menu_selection,picker_index;
static bool details,menu,advanced,task_picker,info_page,confirm_yes,action_dialog,action_choice,action_unavailable,phone_enabled;
static char selected_task_id[PET_ID_MAX+1];
static pet_action_phase_t shown_action_phase;
static pet_settings_action_t settings_confirmation;
static uint32_t keys_seen;
/* Desk mode, pet effects and the event banner. All touched only under the LVGL
 * lock (render/ui_task) or from the LVGL timer, which runs with it held. */
static lv_obj_t *desk,*desk_pet,*desk_eye[2],*desk_glint[2],*desk_dot,*desk_status,*desk_battery,*desk_caption,*desk_count,*desk_rate,*desk_ticker,*desk_spark;
static lv_obj_t *fx_layer,*toast,*toast_icon,*toast_mark,*toast_text;
static lv_timer_t *fx_timer;
static bool desk_mode,desk_shown;
static pet_mood_tracker_t mood_tracker;
static pet_mood_t mood,shown_mood;
static unsigned intensity;
static double odo_shown,odo_target;
static uint32_t spark_values[PET_SPARK_MAX];
static uint8_t spark_len;
static uint32_t fx_frame,fx_seed=0x2545F491u;
typedef struct { int16_t x,y,vx,vy; uint8_t life,max,size,alt; } particle_t;
#define PARTICLES 16
static particle_t particles[PARTICLES];
static int nav_target=-1,focus_target=-1;
/* Host previews snapshot final positions; the device always animates. */
static bool instant_motion;
static uint8_t pet_frame;
/* Two light themes. Colours are read through `theme` so a switch rebuilds the
 * screen once; pets are original artwork (whale bitmap, pixel critter). */
typedef struct {
    const char *name;
    uint32_t bg,card,hero,focus,ink,muted,accent,green,amber,red,spray;
    const lv_image_dsc_t *pet;int pet_x,pet_y;
    int eye_x[2],eye_y,eye_w,eye_h,eye_r;uint32_t eye_color;
    int pupil_x,pupil_y,pupil_w,pupil_h;uint32_t pupil_color;
    /* Desk mode: 2x pet, where particles leave the pet (small-pet pixels), particle look. */
    const lv_image_dsc_t *big;int big_x,big_y,emit_x,emit_y;bool pixel_particles;uint32_t particle,particle_alt;
    /* Optional animated pixel pet (frames by mood); replaces pet/big when set. */
    const pet_pixel_sprite_t *pixel;
} pet_theme_t;
#ifdef PET_WHALE_PIXEL
#define WHALE_SMALL NULL
#define WHALE_BIG NULL
#define WHALE_PIXEL (&pet_whale_pixel)
#else
#define WHALE_SMALL (&pet_whale_img)
#define WHALE_BIG (&pet_whale_big_img)
#define WHALE_PIXEL NULL
#endif
static const pet_theme_t themes[]={
    {"DeepSeek 蓝鲸",0xFFFFFF,0xF4F6FB,0xEEF2FF,0xE3E9FF,0x1D2129,0x86909C,0x4D6BFE,0x17A35B,0xD9820B,0xE5484D,0x9DB4FF,
     WHALE_SMALL,16,54,{PET_WHALE_EYE_X<0?-1:PET_WHALE_EYE_X-3,-1},PET_WHALE_EYE_Y-4,7,9,4,0xFFFFFF,2,1,4,6,0x141828,
     WHALE_BIG,8,34,PET_WHALE_EMIT_X,PET_WHALE_EMIT_Y,false,0x9DB4FF,0xC7D3FF,WHALE_PIXEL},
    {"Claude Code 像素",0xFAF9F5,0xF0EEE6,0xF5E4D8,0xF3DACB,0x1F1E1D,0x87867F,0xC9643F,0x5A8F4E,0xB8740A,0xC4473A,0,
     &pet_critter_img,28,54,{PET_CRITTER_EYE_LX,PET_CRITTER_EYE_RX},PET_CRITTER_EYE_Y,PET_CRITTER_EYE_W,PET_CRITTER_EYE_H,1,0x1F1E1D,1,1,3,3,0xFFFFFF,
     &pet_critter_big_img,40,30,40,22,true,0xF5C47A,0xD97757,NULL},
};
#define THEME_COUNT (sizeof(themes)/sizeof(themes[0]))
static const pet_theme_t *theme=&themes[0];
static unsigned theme_index;
static bool theme_dirty;
#define BG (theme->bg)
#define CARD (theme->card)
#define HERO (theme->hero)
#define FOCUS (theme->focus)
#define INK (theme->ink)
#define MUTED (theme->muted)
#define ACCENT (theme->accent)
#define BLUE (theme->accent)
#define GREEN (theme->green)
#define AMBER (theme->amber)
#define RED (theme->red)
#define SPRAY (theme->spray)
#define F_TITLE (&pet_font_ui_24)
#define F_SMALL (&pet_font_ui_14)
#define F_BODY (&pet_font_cjk_16)
/* Layout inside the board's 30 px rounded corners. */
#define PANEL_X 12
#define PANEL_W 216
#define PANEL_Y 72
#define HOME_PANEL_Y 172
#define HOME_PANEL_H 84
#define PAGE_PANEL_H 184
#define MODAL_PANEL_H 204
#define ROW_PITCH 37
#define ROW_TOP 8
#define SPLASH_X 40
#define SPLASH_Y 50
/* Page layout: slim status bar, content 38..260, segmented tabs, key hint. */
#define TOP_Y 38
#define HERO_Y 38
#define HERO_H 104
#define TILE_Y 148
#define TILE_H 48
#define CURRENT_Y 202
#define CONTENT_BOTTOM 260
#define LIST_TOP 30
#define LIST_PITCH 47
#define TAB_Y 266
static const char *tabs[]={"概览","任务","用量","消息"};
typedef enum { M_PHONE,M_USB,M_PRIVACY,M_LOCAL,M_RELAY,M_PICK,M_OPEN,M_REQUEST,M_THEME,M_ABOUT,M_ADVANCED,M_BACK } menu_action_t;
typedef struct { const char *title,*hint; menu_action_t action; } menu_entry_t;
static const menu_entry_t entries[]={
    {"连接手机","蓝牙配对，120 秒内有效",M_PHONE},
    {"通过 USB 连接","开放 120 秒的 USB 连接",M_USB},
    {"隐私模式","切换公开或私密显示",M_PRIVACY},
    {"使用本地服务","直接连接这台电脑",M_LOCAL},
    {"使用中继服务","不在家时也能查看",M_RELAY},
    {"选择任务","从收到的任务中挑一个",M_PICK},
    {"在电脑上打开","打开前会再确认一次",M_OPEN},
    {"查看请求状态","上一次打开请求的结果",M_REQUEST},
    {"主题","DeepSeek 蓝鲸或 Claude Code 像素",M_THEME},
    {"设备信息","版本和连接方式",M_ABOUT},
    {"设备设置","Wi-Fi、配对与重置",M_ADVANCED},
    {"返回","回到首页",M_BACK}
};
static const char *advanced_titles[]={"忘记 Wi-Fi","解除本地配对","移除中继服务","重置 Agent Pet","返回"};
static const char *advanced_hints[]={"已保存的服务连接会保留","Wi-Fi 和中继会保留","Wi-Fi 和本地连接会保留","清除本应用的全部设置","回到菜单"};
#define ENTRY_COUNT (sizeof(entries)/sizeof(entries[0]))
static size_t pet_ui_object_count(lv_obj_t *root){
    size_t count=1;
    uint32_t children=lv_obj_get_child_count(root);
    for(uint32_t i=0;i<children;i++)count+=pet_ui_object_count(lv_obj_get_child(root,(int32_t)i));
    return count;
}
/* Caller holds the BSP LVGL lock; only numeric resource metrics are logged. */
static void pet_ui_mem(const char *why){
#ifdef CONFIG_LV_USE_CLIB_MALLOC
    ESP_LOGI("pet_mem","%s pool=clib objects=%u heap_free=%u heap_largest=%u",
             why,(unsigned)pet_ui_object_count(screen),(unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
#else
    lv_mem_monitor_t memory={0};
    lv_mem_monitor(&memory);
    ESP_LOGI("pet_mem","%s objects=%u lv_free=%u lv_largest=%u lv_frag=%u lv_peak=%u heap_free=%u heap_largest=%u",
             why,(unsigned)pet_ui_object_count(screen),(unsigned)memory.free_size,
             (unsigned)memory.free_biggest_size,(unsigned)memory.frag_pct,
             (unsigned)memory.max_used,(unsigned)esp_get_free_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
#endif
}
static void first_render_completed(lv_event_t *event){
    static bool reported;
    (void)event;
    if(!reported&&screen&&lv_screen_active()==screen){reported=true;pet_ui_mem("first-render-ready");}
}

static void hide(lv_obj_t *o,bool value){if(value)lv_obj_add_flag(o,LV_OBJ_FLAG_HIDDEN);else lv_obj_remove_flag(o,LV_OBJ_FLAG_HIDDEN);}
static lv_obj_t *shape(lv_obj_t *parent,int x,int y,int w,int h,uint32_t color,int radius){
    lv_obj_t *o=lv_obj_create(parent);lv_obj_remove_style_all(o);lv_obj_remove_flag(o,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_pos(o,x,y);lv_obj_set_size(o,w,h);lv_obj_set_style_bg_color(o,lv_color_hex(color),0);
    lv_obj_set_style_bg_opa(o,LV_OPA_COVER,0);lv_obj_set_style_radius(o,radius,0);return o;
}
static lv_obj_t *label_at(lv_obj_t *parent,int x,int y,int w,int h,const lv_font_t *font,uint32_t color){
    lv_obj_t *o=lv_label_create(parent);lv_obj_set_pos(o,x,y);lv_obj_set_size(o,w,h);
    lv_obj_set_style_text_font(o,font,0);lv_obj_set_style_text_color(o,lv_color_hex(color),0);
    lv_obj_set_style_text_line_space(o,2,0);lv_label_set_long_mode(o,LV_LABEL_LONG_DOT);return o;
}
static void color(lv_obj_t *o,uint32_t value){lv_obj_set_style_text_color(o,lv_color_hex(value),0);}
/* Preserve covered Chinese; unsupported codepoints remain visibly marked '?'. */
static const char *display_text(const char*s){
    static char supported[256];size_t out=0;
    for(const unsigned char*p=(const unsigned char*)s;*p&&out<sizeof(supported)-5;){
        const unsigned char*start=p;uint32_t cp=*p++;unsigned extra=0;
        if(cp>=0xF0){extra=3;cp&=7;}else if(cp>=0xE0){extra=2;cp&=15;}else if(cp>=0xC0){extra=1;cp&=31;}
        for(unsigned i=0;i<extra&&*p;i++)cp=(cp<<6)|(*p++&63);
        lv_font_glyph_dsc_t glyph={0};
        if(lv_font_get_glyph_dsc(&pet_font_cjk_16,&glyph,cp,0)&&!glyph.is_placeholder){size_t n=(size_t)(p-start);memcpy(supported+out,start,n);out+=n;}
        else supported[out++]='?';
    }
    supported[out]=0;return supported;
}
/* ---- Pixel pet ------------------------------------------------------------- */
/* Draw the current frame as run-length rectangles; user data is the scale. */
static void pixel_draw(lv_event_t *e){
    const pet_pixel_sprite_t *sp=theme->pixel;if(!sp)return;
    int scale=(int)(intptr_t)lv_event_get_user_data(e);lv_layer_t *layer=lv_event_get_layer(e);
    lv_area_t box;lv_obj_get_coords(lv_event_get_target_obj(e),&box);
    const char *cells=sp->frames[pet_frame<PET_PIXEL_FRAMES?pet_frame:0];
    if(!cells)cells=sp->frames[PET_PIXEL_REST];
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=LV_OPA_COVER;
    for(int y=0;y<sp->h;y++){
        const char *row=cells+y*sp->w;
        for(int x=0;x<sp->w;){
            char c=row[x];int run=1;while(x+run<sp->w&&row[x+run]==c)run++;
            if(c>='a'&&c<='h'){
                uint32_t argb=sp->palette[c-'a'];
                d.bg_color=lv_color_hex(argb&0xFFFFFF);d.bg_opa=(lv_opa_t)(argb>>24);
                lv_area_t a={box.x1+x*scale,box.y1+y*scale,box.x1+(x+run)*scale-1,box.y1+(y+1)*scale-1};
                lv_draw_rect(layer,&d,&a);
            }
            x+=run;
        }
    }
}
/* `width` is the box the pet fills (112 overview, 224 desk); pixel pets scale to it. */
static lv_obj_t *pet_create(lv_obj_t *parent,const lv_image_dsc_t *img,int width,int x,int y){
    lv_obj_t *o;
    if(theme->pixel){
        int scale=width/theme->pixel->w;if(scale<1)scale=1;
        o=lv_obj_create(parent);lv_obj_remove_style_all(o);lv_obj_remove_flag(o,LV_OBJ_FLAG_SCROLLABLE|LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_size(o,theme->pixel->w*scale,theme->pixel->h*scale);
        lv_obj_add_event_cb(o,pixel_draw,LV_EVENT_DRAW_MAIN,(void*)(intptr_t)scale);
        /* Dispatch each rectangle as it is added. Without this LVGL (no OS) queues
         * all ~220 draw tasks of a frame on the heap before rendering any. */
        lv_obj_add_flag(o,LV_OBJ_FLAG_SEND_DRAW_TASK_EVENTS);
    }else{o=lv_image_create(parent);lv_image_set_src(o,img);}
    lv_obj_set_pos(o,x,y);return o;
}
/* ---- Motion helpers ------------------------------------------------------ */
static void slide(lv_obj_t *o,bool vertical,int to,int *last){
    if(*last==to)return;
    /* First placement (also after a theme rebuild) is immediate: before the first
     * layout pass lv_obj_get_x/y read 0, and a zero-length animation from there
     * never lands on `to`. */
    if(instant_motion||*last<0){
        lv_anim_delete(o,vertical?(lv_anim_exec_xcb_t)lv_obj_set_y:(lv_anim_exec_xcb_t)lv_obj_set_x);
        if(vertical)lv_obj_set_y(o,to);else lv_obj_set_x(o,to);
        *last=to;return;
    }
    lv_anim_exec_xcb_t cb=vertical?(lv_anim_exec_xcb_t)lv_obj_set_y:(lv_anim_exec_xcb_t)lv_obj_set_x;
    lv_anim_delete(o,cb);
    lv_anim_t a;lv_anim_init(&a);lv_anim_set_var(&a,o);lv_anim_set_exec_cb(&a,cb);
    lv_anim_set_values(&a,vertical?lv_obj_get_y(o):lv_obj_get_x(o),to);lv_anim_set_duration(&a,170);
    lv_anim_set_path_cb(&a,lv_anim_path_ease_out);lv_anim_start(&a);
    *last=to;
}
/* ---- Particles (one custom-drawn object, no per-particle allocations) ------ */
static unsigned fx_rand(unsigned n){fx_seed=fx_seed*1664525u+1013904223u;return n?(fx_seed>>8)%n:0;}
/* Invalidate only where a particle is, not the whole layer (SPI/CPU budget). */
static void fx_dirty(const particle_t *p){
    if(!fx_layer)return;
    lv_area_t box;lv_obj_get_coords(fx_layer,&box);
    int x=box.x1+p->x/16,y=box.y1+p->y/16,s=p->size;
    lv_area_t a={x-s/2-1,y-s/2-1,x-s/2+s,y-s/2+s};lv_obj_invalidate_area(fx_layer,&a);
}
static void fx_spawn(int x,int y,int vx,int vy,unsigned life,unsigned size,unsigned alt){
    for(unsigned i=0;i<PARTICLES;i++)if(!particles[i].life){
        particles[i]=(particle_t){(int16_t)(x*16),(int16_t)(y*16),(int16_t)vx,(int16_t)vy,(uint8_t)life,(uint8_t)life,(uint8_t)size,alt};return;}
}
/* Emitter in fx_layer coordinates for the pet currently shown. */
static void fx_origin(int *x,int *y,int *scale){
    if(desk_shown){*scale=2;*x=theme->big_x+theme->emit_x*2;*y=theme->big_y-24+theme->emit_y*2;}
    else{*scale=1;*x=theme->pet_x-PANEL_X+theme->emit_x;*y=theme->pet_y-HERO_Y+theme->emit_y;}
}
static void fx_draw(lv_event_t *e){
    lv_layer_t *layer=lv_event_get_layer(e);lv_area_t box;lv_obj_get_coords(lv_event_get_target_obj(e),&box);
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);
    for(unsigned i=0;i<PARTICLES;i++){
        const particle_t *p=&particles[i];if(!p->life)continue;
        int x=box.x1+p->x/16,y=box.y1+p->y/16,s=p->size;
        if(p->alt==2){
            /* Sleeping "z", drifting up and fading. */
            lv_draw_label_dsc_t z;lv_draw_label_dsc_init(&z);z.font=s>20?F_TITLE:F_SMALL;z.color=lv_color_hex(theme->muted);
            z.opa=(lv_opa_t)(p->life*255/p->max);z.text="z";lv_area_t za={x-s/2,y-s/2,x+s/2,y+s/2};lv_draw_label(layer,&z,&za);continue;
        }
        lv_area_t a={x-s/2,y-s/2,x-s/2+s-1,y-s/2+s-1};
        d.bg_color=lv_color_hex(p->alt?theme->particle_alt:theme->particle);
        d.bg_opa=(lv_opa_t)(p->life*255/p->max);d.radius=theme->pixel_particles?0:LV_RADIUS_CIRCLE;
        lv_draw_rect(layer,&d,&a);
    }
    if(mood==PET_MOOD_ALERT){
        /* Bouncing "!" badge beside the pet's head. */
        int ox,oy,sc;fx_origin(&ox,&oy,&sc);int bounce=(int)(lv_trigo_sin((int16_t)((fx_frame*24)%360))*4/32767);
        lv_area_t a={box.x1+ox+14*sc-10,box.y1+oy-6-abs(bounce)-10,box.x1+ox+14*sc+10,box.y1+oy-6-abs(bounce)+10};
        d.bg_color=lv_color_hex(theme->amber);d.bg_opa=LV_OPA_COVER;d.radius=LV_RADIUS_CIRCLE;lv_draw_rect(layer,&d,&a);
        lv_draw_label_dsc_t t;lv_draw_label_dsc_init(&t);t.font=F_SMALL;t.color=lv_color_hex(0xFFFFFF);t.text="!";t.align=LV_TEXT_ALIGN_CENTER;
        lv_area_t ta={a.x1,a.y1+2,a.x2,a.y2};lv_draw_label(layer,&t,&ta);
    }
}
static void spark_draw(lv_event_t *e){
    lv_layer_t *layer=lv_event_get_layer(e);lv_area_t box;lv_obj_get_coords(lv_event_get_target_obj(e),&box);
    uint32_t peak=1;for(unsigned i=0;i<spark_len;i++)if(spark_values[i]>peak)peak=spark_values[i];
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.radius=1;
    int h=lv_area_get_height(&box),n=PET_SPARK_MAX;
    for(int i=0;i<n;i++){
        uint32_t v=i<n-(int)spark_len?0:spark_values[i-(n-(int)spark_len)];
        int bar=v?(int)(2+(uint64_t)v*(uint64_t)(h-2)/peak):2;
        lv_area_t a={box.x1+i*6,box.y2-bar+1,box.x1+i*6+3,box.y2};
        d.bg_color=lv_color_hex(v?theme->accent:theme->card);d.bg_opa=i==n-1||(i==n-2&&v)?LV_OPA_COVER:LV_OPA_60;
        lv_draw_rect(layer,&d,&a);
    }
}
/* 25 fps: pet bob/blink by mood, particles, odometer roll. Runs in the LVGL task. */
static void fx_tick(lv_timer_t *t){
    (void)t;fx_frame++;
    lv_obj_t *pet=desk_shown?desk_pet:whale;int base=desk_shown?theme->big_y:theme->pet_y;
    int period=mood==PET_MOOD_WORK?24:mood==PET_MOOD_IDLE?54:mood==PET_MOOD_SLEEP?90:16,amp=mood==PET_MOOD_IDLE?2:mood==PET_MOOD_SLEEP?1:mood==PET_MOOD_WORK?3:mood==PET_MOOD_ALERT?5:8;
    int wave=(int)(lv_trigo_sin((int16_t)((fx_frame*360/period)%360))*amp/32767);
    if(mood==PET_MOOD_ALERT||mood==PET_MOOD_CELEBRATE)wave=-abs(wave);
    if(pet&&!lv_obj_has_flag(pet,LV_OBJ_FLAG_HIDDEN))lv_obj_set_y(pet,base+wave*(desk_shown?2:1));
    bool blink=fx_frame%110<4||(mood==PET_MOOD_CELEBRATE&&fx_frame%30<3)||mood==PET_MOOD_SLEEP;
    if(theme->pixel&&pet){
        /* Frame by mood: wag while working, look up when asked, bounce when done, doze when idle long. */
        static const uint8_t wag[4]={PET_PIXEL_REST,PET_PIXEL_TAIL_UP,PET_PIXEL_REST,PET_PIXEL_TAIL_DOWN};
        uint8_t f;
        switch(mood){
            case PET_MOOD_WORK:f=wag[(fx_frame/(intensity>6?2u:3u))%4];break;
            case PET_MOOD_ALERT:f=PET_PIXEL_ALERT;break;
            case PET_MOOD_CELEBRATE:f=(fx_frame/5)%2?PET_PIXEL_HAPPY:PET_PIXEL_SQUASH;break;
            case PET_MOOD_SLEEP:f=PET_PIXEL_BLINK;break;
            default:f=(fx_frame/18)%6==1?PET_PIXEL_TAIL_UP:PET_PIXEL_REST;break;
        }
        if(blink&&(f==PET_PIXEL_REST||f==PET_PIXEL_TAIL_UP||f==PET_PIXEL_TAIL_DOWN))f=PET_PIXEL_BLINK;
        if(f!=pet_frame){pet_frame=f;lv_obj_invalidate(pet);}
    }
    for(unsigned i=0;i<2;i++){
        lv_obj_t *e2=desk_shown?desk_eye[i]:(i?eye2:eye),*g=desk_shown?desk_glint[i]:(i?pupil2:pupil);
        if(!e2)continue;
        lv_obj_set_height(e2,blink?2*(desk_shown?2:1):theme->eye_h*(desk_shown?2:1));hide(g,blink);
    }
    int ox,oy,sc;fx_origin(&ox,&oy,&sc);
    if(mood!=shown_mood){
        if(mood==PET_MOOD_CELEBRATE)for(unsigned i=0;i<12;i++){int ang=(int)(i*30);
            fx_spawn(ox,oy+10*sc,(int)(lv_trigo_cos((int16_t)ang)*(30+fx_rand(20))/32767),(int)(lv_trigo_sin((int16_t)ang)*(30+fx_rand(20))/32767)-14,34,(unsigned)(4*sc),i&1);}
        shown_mood=mood;
    }
    if(mood==PET_MOOD_SLEEP&&fx_frame%40==0)fx_spawn(ox+8*sc,oy,4+(int)fx_rand(4),-6,70,(unsigned)(sc>1?28:18),2);
    unsigned every=mood==PET_MOOD_WORK?(unsigned)(14-intensity):mood==PET_MOOD_IDLE?80:0;
    int spread=theme->pixel_particles?30*sc:4;
    if(every&&fx_frame%every==0)fx_spawn(ox+(int)fx_rand((unsigned)(2*spread+1))-spread,oy,(int)fx_rand(13)-6,-(int)(10+fx_rand(10)+intensity),(unsigned)(36+fx_rand(24)),(unsigned)((theme->pixel_particles?3:2+fx_rand(3))*sc),fx_rand(3)==0);
    for(unsigned i=0;i<PARTICLES;i++){particle_t *q=&particles[i];if(!q->life)continue;fx_dirty(q);q->x+=q->vx;q->y+=q->vy;
        if(mood==PET_MOOD_CELEBRATE)q->vy+=2;else if(!theme->pixel_particles&&fx_frame&1)q->vx=(int16_t)(q->vx+(int)fx_rand(5)-2);
        q->life--;if(q->life)fx_dirty(q);}
    if(fx_layer&&mood==PET_MOOD_ALERT){lv_area_t box;lv_obj_get_coords(fx_layer,&box);
        lv_area_t a={box.x1+ox+14*sc-12,box.y1+oy-30,box.x1+ox+14*sc+12,box.y1+oy+6};lv_obj_invalidate_area(fx_layer,&a);}
    if(desk_shown&&desk_count){
        double gap=odo_target-odo_shown;
        if(gap!=0){odo_shown=(gap>0&&gap<1)||(gap<0&&gap>-1)?odo_target:odo_shown+gap*0.12+(gap>0?1:-1);
            if((gap>0&&odo_shown>odo_target)||(gap<0&&odo_shown<odo_target))odo_shown=odo_target;
            char digits[24],grouped[32];snprintf(digits,sizeof(digits),"%.0f",odo_shown);pet_text_group_digits(digits,grouped,sizeof(grouped));
            lv_label_set_text(desk_count,grouped);}
        lv_obj_set_style_bg_opa(desk_dot,(lv_opa_t)(mood==PET_MOOD_WORK?160+lv_trigo_sin((int16_t)((fx_frame*12)%360))*95/32767:255),0);
    }
}
/* ---- Event banner ---------------------------------------------------------- */
static void toast_hide_now(void){if(!toast)return;lv_anim_delete(toast,NULL);lv_obj_set_y(toast,-60);}
static void show_toast(const pet_event_t *ev){
    if(!toast||ev->kind==PET_EVENT_NONE)return;
    bool ask=ev->kind==PET_EVENT_ASK;
    lv_obj_set_style_bg_color(toast_icon,lv_color_hex(ask?theme->amber:theme->green),0);
    lv_label_set_text(toast_mark,ask?"!":"√");
    char line[160];snprintf(line,sizeof(line),"%s・%s",ask?"需要你回复":"完成",display_text(ev->title));lv_label_set_text(toast_text,line);
    if(instant_motion){lv_obj_set_y(toast,10);return;}
    lv_anim_delete(toast,NULL);
    lv_anim_t a;lv_anim_init(&a);lv_anim_set_var(&a,toast);lv_anim_set_exec_cb(&a,(lv_anim_exec_xcb_t)lv_obj_set_y);
    lv_anim_set_values(&a,-60,10);lv_anim_set_duration(&a,280);lv_anim_set_path_cb(&a,lv_anim_path_ease_out);
    lv_anim_set_reverse_delay(&a,ask?4200:2600);lv_anim_set_reverse_duration(&a,240);lv_anim_start(&a);
}
/* Mood, events, odometer and activity from the latest view. Caller holds the lock. */
static void fx_observe(uint32_t now){
    pet_event_t ev;pet_mood_t next=pet_mood_update(&mood_tracker,&view.current,now,&ev);
    mood=view.public_mode?PET_MOOD_IDLE:next;intensity=pet_mood_intensity(view.current.rate);
    if(!view.public_mode)show_toast(&ev);
    double target=0;for(const char *c=view.current.tokens;*c>='0'&&*c<='9';c++)target=target*10+(*c-'0');
    if(!view.current.usage_known)target=0;
    if(odo_shown==0||target<odo_shown)odo_shown=target>0?target*0.97:0;
    odo_target=target;spark_len=view.current.spark_count;memcpy(spark_values,view.current.spark,sizeof(spark_values));
}
static void build_effects(void){
    /* Desk mode: an opaque full-screen card above the pages. */
    desk=lv_obj_create(screen);lv_obj_remove_style_all(desk);lv_obj_remove_flag(desk,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(desk,240,320);lv_obj_set_style_bg_color(desk,lv_color_hex(BG),0);lv_obj_set_style_bg_opa(desk,LV_OPA_COVER,0);
    desk_dot=shape(desk,20,18,8,8,GREEN,4);
    desk_status=label_at(desk,34,12,140,19,F_SMALL,MUTED);
    desk_battery=label_at(desk,170,12,52,19,F_SMALL,MUTED);lv_obj_set_style_text_align(desk_battery,LV_TEXT_ALIGN_RIGHT,0);
    desk_pet=pet_create(desk,theme->big,PET_WHALE_W*2,theme->big_x,theme->big_y);
    for(unsigned i=0;i<2;i++){
        int x=theme->eye_x[i]<0?0:theme->eye_x[i]*2;
        desk_eye[i]=shape(desk_pet,x,theme->eye_y*2,theme->eye_w*2,theme->eye_h*2,theme->eye_color,theme->eye_r*2);
        desk_glint[i]=shape(desk_eye[i],theme->pupil_x*2,theme->pupil_y*2,theme->pupil_w*2,theme->pupil_h*2,theme->pupil_color,4);
        hide(desk_eye[i],theme->eye_x[i]<0);
    }
    desk_caption=label_at(desk,20,178,200,17,F_SMALL,MUTED);lv_obj_set_style_text_align(desk_caption,LV_TEXT_ALIGN_CENTER,0);
    desk_count=label_at(desk,8,194,224,48,&pet_font_num_40,INK);lv_obj_set_style_text_align(desk_count,LV_TEXT_ALIGN_CENTER,0);
    desk_rate=label_at(desk,20,244,200,17,F_SMALL,ACCENT);lv_obj_set_style_text_align(desk_rate,LV_TEXT_ALIGN_CENTER,0);
    desk_ticker=label_at(desk,24,266,192,22,F_BODY,INK);lv_label_set_long_mode(desk_ticker,LV_LABEL_LONG_MODE_SCROLL_CIRCULAR);
    lv_obj_set_style_text_align(desk_ticker,LV_TEXT_ALIGN_CENTER,0);
    desk_spark=lv_obj_create(desk);lv_obj_remove_style_all(desk_spark);lv_obj_set_pos(desk_spark,31,293);lv_obj_set_size(desk_spark,178,16);
    lv_obj_add_event_cb(desk_spark,spark_draw,LV_EVENT_DRAW_MAIN,NULL);
    hide(desk,true);
    fx_layer=lv_obj_create(screen);lv_obj_remove_style_all(fx_layer);lv_obj_remove_flag(fx_layer,LV_OBJ_FLAG_CLICKABLE|LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(fx_layer,fx_draw,LV_EVENT_DRAW_MAIN,NULL);
    toast=shape(screen,12,-60,216,48,INK,16);
    toast_icon=shape(toast,10,10,28,28,GREEN,14);
    toast_mark=label_at(toast_icon,0,4,28,22,F_BODY,0xFFFFFF);lv_obj_set_style_text_align(toast_mark,LV_TEXT_ALIGN_CENTER,0);
    toast_text=label_at(toast,46,13,160,22,F_BODY,0xFFFFFF);
    memset(particles,0,sizeof(particles));nav_target=focus_target=-1;
    if(!fx_timer)fx_timer=lv_timer_create(fx_tick,40,NULL);
}
static void render_desk(int soc){
    unsigned running=0,waiting=0;const pet_task_t *active=NULL;
    for(unsigned i=0;i<view.current.task_count;i++){const pet_task_t *t=&view.current.tasks[i];running+=t->running;waiting+=t->waiting;
        if(!active||(t->waiting&&!active->waiting)||(t->running&&!active->running&&!active->waiting))active=t;}
    bool fresh=view.current.valid&&view.current.source_connected&&view.current.source_fresh;
    lv_obj_set_style_bg_color(desk_dot,lv_color_hex(waiting?AMBER:fresh?GREEN:MUTED),0);
    if(waiting)lv_label_set_text_fmt(desk_status,"%u 件等你回复",waiting);
    else if(running)lv_label_set_text_fmt(desk_status,"%u 个任务进行中",running);
    else lv_label_set_text(desk_status,!fresh?"等待数据":mood==PET_MOOD_SLEEP?"没事做，打了个盹":"一切安静");
    if(soc<0)lv_label_set_text(desk_battery,"--%");else lv_label_set_text_fmt(desk_battery,"%d%%",soc);
    bool today=!strcmp(view.current.provenance,"magpie-today");
    lv_label_set_text(desk_caption,today?"今日 Token":"累计 Token");
    if(!view.current.usage_known)lv_label_set_text(desk_count,"--");
    char line[96];
    snprintf(line,sizeof(line),"%s%s%s%s%s",view.current.rate[0]?view.current.rate:"",view.current.rate[0]?" t/s":"",
             view.current.rate[0]&&view.current.cost[0]?"・":"",view.current.cost[0]&&view.current.cost_estimate?"约":"",view.current.cost);
    lv_label_set_text(desk_rate,line[0]?line:"等待用量数据");
    if(active){char t[200];snprintf(t,sizeof(t),"%s%s%s%s",active->waiting?"等你回复：":active->running?"进行中：":"最近：",display_text(active->title),active->agent[0]?"・":"",active->agent);
        if(strcmp(lv_label_get_text(desk_ticker),t))lv_label_set_text(desk_ticker,t);}
    else lv_label_set_text(desk_ticker,"新任务会出现在这里");
    lv_obj_invalidate(desk_spark);
}
static void build(void){
    screen=lv_obj_create(NULL);lv_obj_remove_style_all(screen);lv_obj_remove_flag(screen,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(screen,lv_color_hex(BG),0);lv_obj_set_style_bg_opa(screen,LV_OPA_COVER,0);
    heading=label_at(screen,18,9,148,34,F_TITLE,INK);
    battery=label_at(screen,166,17,58,20,F_SMALL,MUTED);lv_obj_set_style_text_align(battery,LV_TEXT_ALIGN_RIGHT,0);
    status_dot=shape(screen,19,52,6,6,MUTED,3);
    health=label_at(screen,31,45,193,20,F_SMALL,MUTED);
    hero=shape(screen,PANEL_X,HERO_Y,PANEL_W,HERO_H,HERO,18);
    /* Theme pet bitmap; plain image blit, no transformed layers. The eyes are
     * children so they bob with the body and can blink. */
    whale=pet_create(screen,theme->pet,PET_WHALE_W,theme->pet_x,theme->pet_y);
    eye=shape(whale,theme->eye_x[0]<0?0:theme->eye_x[0],theme->eye_y,theme->eye_w,theme->eye_h,theme->eye_color,theme->eye_r);hide(eye,theme->eye_x[0]<0);
    pupil=shape(eye,theme->pupil_x,theme->pupil_y,theme->pupil_w,theme->pupil_h,theme->pupil_color,2);
    eye2=shape(whale,theme->eye_x[1]<0?0:theme->eye_x[1],theme->eye_y,theme->eye_w,theme->eye_h,theme->eye_color,theme->eye_r);
    pupil2=shape(eye2,theme->pupil_x,theme->pupil_y,theme->pupil_w,theme->pupil_h,theme->pupil_color,2);
    hide(eye2,theme->eye_x[1]<0);
    splash=shape(screen,SPLASH_X,SPLASH_Y,5,5,SPRAY?SPRAY:HERO,3);
    hero_primary=label_at(screen,136,58,88,34,F_TITLE,INK);
    hero_secondary=label_at(screen,136,96,88,22,F_BODY,MUTED);
    for(unsigned i=0;i<3;i++){
        tile[i]=shape(screen,PANEL_X+(int)i*74,TILE_Y,68,TILE_H,CARD,14);
        tile_label[i]=label_at(tile[i],8,5,58,17,F_SMALL,MUTED);
        tile_value[i]=label_at(tile[i],8,23,58,21,F_BODY,INK);
    }
    body_panel=shape(screen,PANEL_X,HOME_PANEL_Y,PANEL_W,HOME_PANEL_H,CARD,18);
    menu_focus=shape(body_panel,6,ROW_TOP,204,35,FOCUS,10);hide(menu_focus,true);
    section=label_at(body_panel,14,10,188,20,F_SMALL,ACCENT);
    body=label_at(body_panel,14,34,188,44,F_BODY,INK);
    for(unsigned i=0;i<LIST_ROWS;i++){
        list_title[i]=label_at(body_panel,12,0,138,21,F_BODY,INK);
        list_value[i]=label_at(body_panel,148,0,56,17,F_SMALL,MUTED);lv_obj_set_style_text_align(list_value[i],LV_TEXT_ALIGN_RIGHT,0);
        list_sub[i]=label_at(body_panel,12,0,192,17,F_SMALL,MUTED);
    }
    for(unsigned i=0;i<ROW_COUNT;i++){rows[i]=label_at(body_panel,16,ROW_TOP+7+(int)i*ROW_PITCH,184,22,F_BODY,INK);hide(rows[i],true);}
    /* Segmented tabs: a sliding filled pill behind the active label. */
    nav_bg=shape(screen,PANEL_X,TAB_Y,PANEL_W,26,CARD,13);
    nav_mark=shape(screen,PANEL_X+2,TAB_Y+2,52,22,ACCENT,11);
    for(unsigned i=0;i<4;i++){
        nav[i]=label_at(screen,PANEL_X+2+(int)i*53,TAB_Y+4,52,18,F_SMALL,MUTED);
        lv_obj_set_style_text_align(nav[i],LV_TEXT_ALIGN_CENTER,0);lv_label_set_text(nav[i],tabs[i]);
    }
    footer=label_at(screen,16,296,208,18,F_SMALL,MUTED);lv_obj_set_style_text_align(footer,LV_TEXT_ALIGN_CENTER,0);
    qr=lv_qrcode_create(screen);lv_qrcode_set_size(qr,168);lv_obj_set_pos(qr,36,80);
    lv_qrcode_set_dark_color(qr,lv_color_hex(INK));lv_qrcode_set_light_color(qr,lv_color_hex(0xFFFFFF));hide(qr,true);
    build_effects();
    lv_screen_load(screen);
}
static pet_task_t *selected_task(void){
    if(!view.current.task_count)return NULL;
    if(selected_task_id[0])for(unsigned i=0;i<view.current.task_count;i++)if(!strcmp(selected_task_id,view.current.tasks[i].id)){selected=i;return &view.current.tasks[i];}
    if(selected>=view.current.task_count)selected=0;
    return &view.current.tasks[selected];
}
static void remember_task(unsigned index){
    if(index<view.current.task_count){selected=index;snprintf(selected_task_id,sizeof(selected_task_id),"%s",view.current.tasks[index].id);}
}
static void open_dialog(void){
    pet_task_t *task=selected_task();action_choice=false;action_dialog=true;menu=false;task_picker=false;
    action_unavailable=!task||!pet_runtime_open_prepare(task->id);shown_action_phase=PET_ACTION_IDLE;
}
static bool retry_available(void){return action_view.target_id[0]&&(action_view.phase==PET_ACTION_FAILED||action_view.phase==PET_ACTION_CONFLICT||action_view.phase==PET_ACTION_EXPIRED);}
static bool alternative_available(void){return action_view.can_confirm||action_view.can_query||retry_available();}
/* One card fills the content area; section and body start at its top. */
static void full_panel(const char *caption,int height){
    lv_obj_set_pos(body_panel,PANEL_X,PANEL_Y);lv_obj_set_height(body_panel,height);
    lv_obj_set_pos(body,14,34);lv_obj_set_height(body,height-44);
    lv_obj_set_pos(section,14,10);color(section,ACCENT);
    lv_label_set_text(section,caption);hide(section,false);
}
/* Highlighted option rows; the focused row uses the accent colour. */
static void choices(const char *const options[],unsigned count,unsigned cursor,int top){
    if(count>ROW_COUNT)count=ROW_COUNT;
    for(unsigned i=0;i<ROW_COUNT;i++){
        hide(rows[i],i>=count);if(i>=count)continue;
        lv_obj_set_pos(rows[i],16,top+7+(int)i*ROW_PITCH);lv_label_set_text(rows[i],options[i]);
        color(rows[i],i==cursor?ACCENT:INK);
    }
    lv_obj_set_size(menu_focus,204,35);lv_obj_set_x(menu_focus,6);slide(menu_focus,true,top+(int)cursor*ROW_PITCH,&focus_target);hide(menu_focus,false);
}
/* ---- Page building blocks --------------------------------------------- */
static void page_panel(int y,int h){
    lv_obj_set_pos(body_panel,PANEL_X,y);lv_obj_set_height(body_panel,h);
    lv_obj_set_pos(section,12,8);hide(section,false);lv_obj_set_pos(body,12,32);lv_obj_set_height(body,h-40);
}
static void list_row(unsigned i,int y,const lv_font_t *font,const char *title,const char *sub,uint32_t sub_color,const char *value){
    hide(list_title[i],false);lv_obj_set_style_text_font(list_title[i],font,0);
    lv_obj_set_pos(list_title[i],12,y+4);lv_label_set_text(list_title[i],title);
    hide(list_value[i],!value||!value[0]);if(value)lv_label_set_text(list_value[i],value);lv_obj_set_pos(list_value[i],148,y+6);
    hide(list_sub[i],!sub||!sub[0]);if(sub){lv_label_set_text(list_sub[i],sub);color(list_sub[i],sub_color);}
    lv_obj_set_pos(list_sub[i],12,y+(font==F_SMALL?22:25));
}
/* Highlight row `cursor` of a list whose rows start at LIST_TOP. */
static void list_focus(unsigned cursor,int pitch){
    lv_obj_set_size(menu_focus,204,pitch-3);lv_obj_set_x(menu_focus,6);
    slide(menu_focus,true,LIST_TOP-2+(int)cursor*pitch,&focus_target);hide(menu_focus,false);
}
static unsigned list_window(unsigned cursor,unsigned count,unsigned rows){
    unsigned start=cursor>1?cursor-1:0;
    if(count<=rows)return 0;
    return start>count-rows?count-rows:start;
}
static void tiles(int y,const char *const labels[3],const char *const values[3]){
    for(unsigned i=0;i<3;i++){
        hide(tile[i],false);lv_obj_set_y(tile[i],y);
        lv_label_set_text(tile_label[i],labels[i]);lv_label_set_text(tile_value[i],values[i]&&values[i][0]?values[i]:"--");
    }
}
static uint32_t task_color(const pet_task_t *t){return t->waiting?AMBER:t->running?ACCENT:t->state==PET_FAILED?RED:MUTED;}
static void render_menu(void){
    char row[160];unsigned count=task_picker?view.current.task_count+1:advanced?5:(unsigned)ENTRY_COUNT;
    unsigned cursor=task_picker?picker_index:menu_selection;if(cursor>=count)cursor=0;
    full_panel("",ROW_TOP*2+ROW_PITCH*ROW_COUNT);hide(section,true);hide(body,true);
    lv_label_set_text(heading,task_picker?"选择任务":advanced?"设备设置":"菜单");
    lv_label_set_text_fmt(battery,"%u/%u",cursor+1,count);
    const char *hint=task_picker?(cursor<view.current.task_count?pet_text_task_state(&view.current.tasks[cursor]):"回到菜单"):advanced?advanced_hints[cursor]:entries[cursor].hint;
    lv_label_set_text(health,hint);
    /* Keep the cursor on the middle row while scrolling a long list. */
    unsigned start=cursor>2?cursor-2:0;
    if(count<=ROW_COUNT)start=0;else if(start>count-ROW_COUNT)start=count-ROW_COUNT;
    lv_obj_set_size(menu_focus,204,35);lv_obj_set_x(menu_focus,6);slide(menu_focus,true,ROW_TOP+(int)(cursor-start)*ROW_PITCH,&focus_target);hide(menu_focus,false);
    for(unsigned i=0;i<ROW_COUNT;i++){
        lv_obj_t *o=rows[i];unsigned index=start+i;hide(o,index>=count);if(index>=count)continue;
        lv_obj_set_pos(o,16,ROW_TOP+7+(int)i*ROW_PITCH);
        if(task_picker){if(index==view.current.task_count)snprintf(row,sizeof(row),"返回");else snprintf(row,sizeof(row),"%u. %s",index+1,display_text(view.current.tasks[index].title));}
        else snprintf(row,sizeof(row),"%s",advanced?advanced_titles[index]:entries[index].title);
        lv_label_set_text(o,row);color(o,index==cursor?ACCENT:INK);
    }
    lv_label_set_text(footer,task_picker||advanced?"上下选择・OK 确认・长按返回":"上下选择・OK 确认・长按关闭");
}
static const char *settings_question(void){
    switch(settings_confirmation){
        case PET_SETTINGS_FORGET_WIFI:return "忘记所有已保存的 Wi-Fi？\n完成后设备会重启。";
        case PET_SETTINGS_UNPAIR:return "解除与本地服务的配对？\n完成后设备会重启。";
        case PET_SETTINGS_DISABLE_REMOTE:return "移除中继服务？\n完成后设备会重启。";
        default:return "重置 Agent Pet？\n本应用的设置会被清除，\n完成后设备会重启。";
    }
}
static void render(const char *status,int soc){
    char text[640];
    hide(desk,!desk_mode);desk_shown=desk_mode;hide(fx_layer,true);
    if(desk_mode){hide(fx_layer,false);lv_obj_set_pos(fx_layer,0,24);lv_obj_set_size(fx_layer,240,156);render_desk(soc);return;}
    hide(qr,true);hide(hero,true);hide(whale,true);hide(splash,true);
    hide(hero_primary,true);hide(hero_secondary,true);hide(menu_focus,true);hide(section,false);hide(body,false);
    for(unsigned i=0;i<LIST_ROWS;i++){hide(list_title[i],true);hide(list_sub[i],true);hide(list_value[i],true);}
    for(unsigned i=0;i<3;i++)hide(tile[i],true);
    for(unsigned i=0;i<ROW_COUNT;i++)hide(rows[i],true);
    bool linking=pet_runtime_link_requested()&&!menu;
    bool modal=menu||settings_confirmation||action_dialog||info_page||pet_provision_active()||pet_runtime_setup_pending()||linking;
    /* Pages: slim status bar and no title (the tabs name the page). Modals keep a title. */
    hide(heading,!modal);
    lv_obj_set_pos(status_dot,19,modal?52:18);lv_obj_set_pos(health,31,modal?45:11);lv_obj_set_y(battery,modal?17:11);
    for(unsigned i=0;i<4;i++){hide(nav[i],modal);color(nav[i],i==page_index?0xFFFFFF:MUTED);}
    hide(nav_bg,modal);hide(nav_mark,modal);slide(nav_mark,false,PANEL_X+2+(int)page_index*53,&nav_target);
    lv_label_set_text(heading,tabs[page_index]);
    if(soc<0)lv_label_set_text(battery,"--%");else lv_label_set_text_fmt(battery,"%d%%",soc);
    bool fresh=view.current.valid&&view.current.source_connected&&view.current.source_fresh;
    lv_obj_set_style_bg_color(status_dot,lv_color_hex(fresh?GREEN:view.current.valid?AMBER:MUTED),0);
    color(health,MUTED);color(body,INK);
    lv_label_set_text(health,pet_text_status(status,fresh,view.transport==PET_TRANSPORT_REMOTE));
    unsigned usb_seconds=pet_runtime_setup_seconds();
    if(usb_seconds){
        if(fresh)lv_label_set_text(health,"USB 实时同步");else lv_label_set_text_fmt(health,"USB 已开放・剩 %u 秒",usb_seconds);
        color(health,ACCENT);lv_obj_set_style_bg_color(status_dot,lv_color_hex(fresh?GREEN:BLUE),0);
    }
    lv_obj_set_pos(body_panel,PANEL_X,HOME_PANEL_Y);
    if(pet_provision_active()&&!menu){
        lv_label_set_text(heading,"手机配对");lv_label_set_text(health,phone_enabled?"用手机 App 扫描二维码":"按 OK 开启蓝牙");hide(body_panel,true);
        if(pet_provision_qr(qr_payload,sizeof(qr_payload))){
            if(strcmp(qr_payload,shown_qr)){if(lv_qrcode_update(qr,qr_payload,strlen(qr_payload))==LV_RESULT_OK)snprintf(shown_qr,sizeof(shown_qr),"%s",qr_payload);else lv_label_set_text(health,"二维码不可用，请用 USB");}
            if(shown_qr[0])hide(qr,false);
        }else lv_label_set_text(health,"正在准备安全配对");
        lv_label_set_text(footer,phone_enabled?"长按 OK 关闭":"OK 开启蓝牙・长按关闭");return;
    }
    hide(body_panel,false);memset(shown_qr,0,sizeof(shown_qr));memset(qr_payload,0,sizeof(qr_payload));
    if(linking){
        lv_label_set_text(heading,"连接电脑");full_panel("电脑请求连接",MODAL_PANEL_H);
        lv_label_set_text(body,"插着 USB 的电脑想同步\n你的任务进度和用量。\n\n只读显示，不会改设置。\n按 OK 允许。");
        lv_label_set_text(footer,"OK 允许・长按 OK 拒绝");return;
    }
    if(pet_runtime_setup_pending()&&!menu){
        char ssid[40];bool wifi=pet_runtime_setup_ssid(ssid,sizeof(ssid));
        lv_label_set_text(heading,wifi?"连接 Wi-Fi":"USB 连接");full_panel(wifi?"电脑发来的 Wi-Fi":"确认连接",MODAL_PANEL_H);
        if(wifi){snprintf(text,sizeof(text),"要连接这个 Wi-Fi 吗？\n「%s」\n\n连上后不插线也能看到\n电脑上的任务。",display_text(ssid));lv_label_set_text(body,text);}
        else lv_label_set_text(body,"要应用电脑发来的设置吗？\n\n只有你自己发起的设置\n才可以继续。");
        lv_label_set_text(footer,"OK 确认・长按 OK 取消");return;
    }
    if(settings_confirmation){
        static const char *const options[]={"取消","确认并重启"};
        lv_label_set_text(heading,"请确认");full_panel("设备设置",MODAL_PANEL_H);
        lv_label_set_text(body,settings_question());
        choices(options,2,confirm_yes?1:0,MODAL_PANEL_H-ROW_TOP-2*ROW_PITCH);
        lv_label_set_text(footer,"上下选择・OK 确认");return;
    }
    if(action_dialog){
        bool no_request=!action_unavailable&&action_view.phase==PET_ACTION_IDLE&&!action_view.target_id[0];
        lv_label_set_text(heading,"你的电脑");
        full_panel(no_request?"暂无请求":action_unavailable?"暂不可用":pet_text_action_title(action_view.phase),MODAL_PANEL_H);
        if(no_request){lv_label_set_text(body,"还没有打开请求。\n先在任务页选一个任务，\n再选“在电脑上打开”。");}
        else if(action_unavailable){lv_label_set_text(body,"现在无法打开。\n请检查本地连接，\n或查看上次请求的状态。");}
        else lv_label_set_text(body,display_text(action_view.title));
        bool two=!no_request&&!action_unavailable&&alternative_available();
        const char *options[2]={two?(action_view.can_confirm?"取消":"关闭"):"返回",action_view.can_confirm?"打开":action_view.can_query?"查看结果":"重试"};
        choices(options,two?2:1,two&&action_choice?1:0,MODAL_PANEL_H-ROW_TOP-2*ROW_PITCH);
        lv_label_set_text(footer,two?"上下选择・OK 确认":"OK 返回・长按返回");return;
    }
    if(info_page){
        lv_label_set_text(heading,"设备信息");full_panel("AGENT PET",MODAL_PANEL_H);
        snprintf(text,sizeof(text),"固件版本 0.2-dev\n连接方式：%s\n主题：%s\n最多保存 3 个 Wi-Fi",view.transport==PET_TRANSPORT_REMOTE?"中继服务":"本地服务",theme->name);
        lv_label_set_text(body,text);
        lv_label_set_text(footer,"OK 返回菜单");return;
    }
    if(menu){render_menu();return;}
    if(view.public_mode){
        page_panel(TOP_Y,CONTENT_BOTTOM-TOP_Y);lv_label_set_text(section,"公开模式");
        lv_label_set_text(body,"私密内容已隐藏。\n\n长按 OK 打开菜单，\n在“隐私模式”中关闭。");
        lv_label_set_text(footer,"上下翻页・长按 OK 菜单");return;
    }
    char a[32],b[32];
    bool today=!strcmp(view.current.provenance,"magpie-today");
    if(page_index==0){
        hide(hero,false);hide(whale,false);hide(splash,!SPRAY);
        hide(fx_layer,false);lv_obj_set_pos(fx_layer,PANEL_X,HERO_Y);lv_obj_set_size(fx_layer,PANEL_W,HERO_H);hide(hero_primary,false);hide(hero_secondary,false);
        unsigned running=0,waiting=0;int best=-1,rank=-1;
        for(unsigned i=0;i<view.current.task_count;i++){pet_task_t *task=&view.current.tasks[i];running+=task->running;waiting+=task->waiting;int r=task->waiting?3:task->running?2:task->state==PET_FAILED?1:0;if(r>rank){best=(int)i;rank=r;}}
        lv_obj_set_style_bg_color(splash,lv_color_hex(waiting?AMBER:SPRAY),0);
        color(hero_secondary,MUTED);
        if(!view.current.valid){lv_label_set_text(hero_primary,"你好");lv_label_set_text(hero_secondary,"先来连接吧");}
        else if(waiting){lv_label_set_text(hero_primary,"待处理");lv_label_set_text_fmt(hero_secondary,"%u 件待回复",waiting);color(hero_secondary,AMBER);}
        else if(running){lv_label_set_text(hero_primary,"忙碌中");lv_label_set_text_fmt(hero_secondary,"%u 个进行中",running);color(hero_secondary,ACCENT);}
        else{lv_label_set_text(hero_primary,mood==PET_MOOD_SLEEP?"打个盹":"很安静");lv_label_set_text(hero_secondary,fresh?"已是最新":"上次的数据");}
        /* Today at a glance. */
        pet_text_compact_count(view.current.tokens,a,sizeof(a));
        const char *labels[3]={today?"今日用量":"累计用量","速度 t/s",view.current.cost_estimate?"估算费用":"费用"},*values[3]={view.current.usage_known?a:"",view.current.rate,view.current.cost};
        tiles(TILE_Y,labels,values);
        /* One line for the task that matters most. */
        page_panel(CURRENT_Y,CONTENT_BOTTOM-CURRENT_Y-2);lv_obj_set_pos(section,12,6);lv_obj_set_pos(body,12,26);lv_obj_set_height(body,22);
        lv_label_set_long_mode(body,LV_LABEL_LONG_DOT);
        if(!view.current.valid){lv_label_set_text(section,"开始使用");color(section,ACCENT);lv_label_set_text(body,"插上 USB，按 OK 连接电脑");}
        else if(best<0){lv_label_set_text(section,"一切就绪");color(section,ACCENT);lv_label_set_text(body,"新任务会显示在这里");}
        else{const pet_task_t *t=&view.current.tasks[best];
            snprintf(text,sizeof(text),"%s%s%s",waiting?"需要你处理":rank>=2?pet_text_task_state(t):"最近的任务",t->agent[0]?"・":"",display_text(t->agent));
            lv_label_set_text(section,text);color(section,task_color(t));lv_label_set_text(body,display_text(t->title));}
        lv_label_set_text(footer,view.current.task_count?"OK 查看任务・长按 OK 菜单":!view.current.valid?"OK 连接电脑・长按 OK 菜单":"OK 打开菜单・长按 OK 菜单");return;
    }
    color(section,ACCENT);
    if(page_index==1){
        page_panel(TOP_Y,CONTENT_BOTTOM-TOP_Y);
        unsigned count=view.current.task_count;
        if(!count){lv_label_set_text(section,"还没有任务");lv_label_set_text(body,"连接电脑后，\n这里会实时显示任务。");}
        else{
            hide(body,true);selected_task();
            if(view.current.total_tasks>count)lv_label_set_text_fmt(section,"%u 个对话・电脑上共 %lu 个",count,(unsigned long)view.current.total_tasks);
            else lv_label_set_text_fmt(section,"%u 个对话",count);
            unsigned start=list_window(selected,count,LIST_ROWS);
            for(unsigned i=0;i<LIST_ROWS&&start+i<count;i++){
                const pet_task_t *t=&view.current.tasks[start+i];
                char title[200],sub[96],tokens[24]="";
                snprintf(title,sizeof(title),"%s",display_text(t->title));
                snprintf(sub,sizeof(sub),"%s%s%s",pet_text_task_state(t),t->agent[0]?"・":"",display_text(t->agent));
                if(t->tokens[0])pet_text_compact_count(t->tokens,tokens,sizeof(tokens));
                list_row(i,LIST_TOP+(int)i*LIST_PITCH,F_BODY,title,sub,task_color(t),tokens);
            }
            list_focus(selected-start,LIST_PITCH);
        }
        lv_label_set_text(footer,count>1?"OK 下一个・长按 OK 菜单":count?"OK 在电脑上打开・长按菜单":"OK 开始连接・长按 OK 菜单");return;
    }
    if(page_index==2){
        if(!view.current.usage_known){
            page_panel(TOP_Y,CONTENT_BOTTOM-TOP_Y);lv_label_set_text(section,today?"今日用量":"累计用量");
            lv_label_set_text(body,"还没有可验证的用量，\n连接电脑后显示。");
            lv_label_set_text(footer,"上下翻页・长按 OK 菜单");return;
        }
        pet_text_compact_count(view.current.tokens,a,sizeof(a));
        const char *labels[3]={today?"今日用量":"累计用量","平均 t/s",view.current.cost_estimate?"估算费用":"费用"},*values[3]={a,view.current.rate,view.current.cost};
        tiles(TOP_Y,labels,values);
        int panel_y=TOP_Y+TILE_H+6;page_panel(panel_y,CONTENT_BOTTOM-panel_y);
        unsigned count=view.current.model_count,pages=(count+USAGE_ROWS-1)/USAGE_ROWS;
        lv_label_set_text(section,count?(today?"按模型・今日":"按模型"):"按模型");
        if(!count){lv_label_set_text(body,today?"今天还没有按模型的明细。":"来源没有提供按模型的明细。");}
        else{
            hide(body,true);if(usage_page>=pages)usage_page=0;
            for(unsigned i=0;i<USAGE_ROWS;i++){
                unsigned index=usage_page*USAGE_ROWS+i;if(index>=count)break;
                const pet_usage_model_t *m=&view.current.models[index];
                pet_text_compact_count(m->tokens,b,sizeof(b));
                snprintf(text,sizeof(text),"%s%s%s%s",m->cost,m->cost[0]&&m->rate[0]?"・":"",m->rate,m->rate[0]?" t/s":"");
                list_row(i,LIST_TOP+(int)i*44,F_BODY,display_text(m->name),text,MUTED,m->tokens[0]?b:"--");
            }
        }
        if(pages>1)lv_label_set_text_fmt(footer,"OK 下一页 %u/%u・长按 OK 菜单",usage_page+1,pages);
        else lv_label_set_text(footer,"上下翻页・长按 OK 菜单");
        return;
    }
    page_panel(TOP_Y,CONTENT_BOTTOM-TOP_Y);
    unsigned count=view.current.inbox_count;
    if(!count){lv_label_set_text(section,"没有新消息");lv_label_set_text(body,"都处理完了。\n新的提醒会出现在这里。");}
    else{
        hide(body,true);if(selected>=count)selected=0;
        lv_label_set_text_fmt(section,"%u 条提醒",count);
        unsigned start=list_window(selected,count,LIST_ROWS);
        for(unsigned i=0;i<LIST_ROWS&&start+i<count;i++){
            snprintf(text,sizeof(text),"%s",display_text(pet_text_inbox(view.current.inbox[start+i])));
            list_row(i,LIST_TOP+(int)i*LIST_PITCH,F_BODY,text,NULL,MUTED,NULL);
        }
        list_focus(selected-start,LIST_PITCH);
    }
    lv_label_set_text(footer,count>1?"OK 下一条・长按 OK 菜单":"上下翻页・长按 OK 菜单");
}
static void on_key(bsp_btn_t b,bsp_btn_ev_t e,void*arg){
    static pet_input_t tracker;
    (void)arg;
    if(key_guard_consume(&guard,e==BSP_BTN_RELEASE,esp_timer_get_time()))return;
    pet_key_phase_t phase;
    if(e==BSP_BTN_PRESS)phase=PET_KEY_PRESS;
    else if(e==BSP_BTN_RELEASE)phase=PET_KEY_RELEASE;
    else if(e==BSP_BTN_LONG)phase=PET_KEY_HOLD;
    else return;
    pet_key_action_t action=pet_input_reduce(&tracker,b,phase);
    if(action==PET_KEY_NONE)return;
    input_t in={b,action==PET_KEY_LONG?BSP_BTN_LONG:BSP_BTN_CLICK};if(keys)xQueueSend(keys,&in,0);
}

static void close_action(void){pet_runtime_open_cancel();action_dialog=false;action_unavailable=false;action_choice=false;}
static void input(const input_t *event){
    if(keys_seen<UINT32_MAX)keys_seen++;
    /* Any key only wakes the page from desk mode; it does nothing else. */
    if(desk_mode){desk_mode=false;return;}
    if(event->event==BSP_BTN_LONG){
        if(event->button==BSP_BTN_OK){
            if(pet_runtime_link_requested()&&!menu){pet_runtime_link_dismiss();return;}
            if(action_dialog){close_action();return;}
            if(pet_provision_active()){pet_provision_stop();phone_enabled=false;return;}
            if(pet_runtime_setup_pending()){pet_runtime_cancel_setup();return;}
            if(settings_confirmation){settings_confirmation=0;return;}
            if(task_picker){task_picker=false;return;}
            if(info_page){info_page=false;menu=true;return;}
            if(menu&&advanced){advanced=false;menu_selection=M_ADVANCED;return;}
            menu=!menu;if(menu){menu_selection=0;advanced=false;}
            details=false;
        }
        return;
    }
    bool arrow=event->button==BSP_BTN_UP||event->button==BSP_BTN_DOWN;
    int direction=event->button==BSP_BTN_UP?-1:1;
    if(action_dialog){
        if(arrow){if(!action_unavailable&&alternative_available())action_choice=!action_choice;return;}
        if(action_unavailable||!action_choice||!alternative_available()){close_action();return;}
        if(action_view.can_confirm){pet_runtime_open_confirm();action_choice=false;}
        else if(action_view.can_query){pet_runtime_open_query();action_choice=false;}
        else if(retry_available()){action_unavailable=!pet_runtime_open_prepare(action_view.target_id);action_choice=false;}
        return;
    }
    if(pet_runtime_link_requested()&&!menu){if(event->button==BSP_BTN_OK)pet_runtime_setup_window();return;}
    if(pet_provision_active()&&!menu){if(event->button==BSP_BTN_OK&&qr_payload[0]){pet_provision_confirm();phone_enabled=true;}return;}
    if(pet_runtime_setup_pending()&&!menu){if(event->button==BSP_BTN_OK)pet_runtime_confirm();return;}
    if(settings_confirmation){if(arrow)confirm_yes=!confirm_yes;else{if(confirm_yes)pet_runtime_settings_action(settings_confirmation);settings_confirmation=0;menu=false;}return;}
    if(info_page){if(event->button==BSP_BTN_OK){info_page=false;menu=true;}return;}
    if(menu){
        unsigned count=task_picker?view.current.task_count+1:advanced?5:(unsigned)ENTRY_COUNT;
        unsigned *cursor=task_picker?&picker_index:&menu_selection;
        if(arrow){*cursor=direction<0?(*cursor+count-1)%count:(*cursor+1)%count;return;}
        if(task_picker){if(picker_index<view.current.task_count){remember_task(picker_index);page_index=1;menu=false;}task_picker=false;return;}
        if(advanced){if(menu_selection==4){advanced=false;menu_selection=M_ADVANCED;}else{settings_confirmation=menu_selection==0?PET_SETTINGS_FORGET_WIFI:menu_selection==1?PET_SETTINGS_UNPAIR:menu_selection==2?PET_SETTINGS_DISABLE_REMOTE:PET_SETTINGS_FACTORY_RESET;confirm_yes=false;}return;}
        switch(entries[menu_selection].action){
            case M_PHONE:menu=false;phone_enabled=false;pet_provision_start();break;
            case M_USB:menu=false;pet_runtime_setup_window();break;
            case M_PRIVACY:pet_runtime_privacy(!view.public_mode);menu=false;break;
            case M_LOCAL:pet_runtime_select_transport(PET_TRANSPORT_LOCAL);menu=false;break;
            case M_RELAY:pet_runtime_select_transport(PET_TRANSPORT_REMOTE);menu=false;break;
            case M_PICK:task_picker=true;picker_index=selected;break;
            case M_OPEN:open_dialog();break;
            case M_REQUEST:action_dialog=true;action_choice=false;action_unavailable=false;menu=false;break;
            case M_THEME:theme_index=(theme_index+1)%THEME_COUNT;pet_runtime_set_theme((uint8_t)theme_index);theme_dirty=true;menu=false;page_index=0;break;
            case M_ABOUT:info_page=true;menu=false;break;
            case M_ADVANCED:advanced=true;menu_selection=0;break;
            case M_BACK:menu=false;break;
        }
        return;
    }
    if(arrow){page_index=(page_index+(direction<0?3:1))%4;selected=0;selected_task_id[0]=0;details=false;usage_page=0;return;}
    if(view.public_mode){menu=true;menu_selection=M_PRIVACY;return;}
    if(page_index==0){if(view.current.task_count){page_index=1;unsigned best=0;int rank=-1;for(unsigned i=0;i<view.current.task_count;i++){pet_task_t *task=&view.current.tasks[i];int r=task->waiting?3:task->running?2:task->state==PET_FAILED?1:0;if(r>rank){best=i;rank=r;}}remember_task(best);}else if(!view.current.valid)pet_runtime_setup_window();else{menu=true;menu_selection=0;}return;}
    if(page_index==1){if(!view.current.task_count){menu=true;menu_selection=0;}else if(view.current.task_count>1)remember_task((selected+1)%view.current.task_count);else open_dialog();return;}
    if(page_index==2){unsigned pages=(view.current.model_count+USAGE_ROWS-1)/USAGE_ROWS;usage_page=pages>1?(usage_page+1)%pages:0;return;}
    if(view.current.inbox_count)selected=(selected+1)%view.current.inbox_count;
}
/* Caller holds the LVGL lock: build the new themed screen, load it, then free the old one. */
static void rebuild_theme(void){
    /* Free the old UI before building the new one: peak is one UI, not two, and
     * the new objects reuse the freed blocks instead of fragmenting the heap. */
    lv_obj_t *old=screen,*blank=lv_obj_create(NULL);
    lv_screen_load(blank);lv_obj_delete(old);
    theme=&themes[theme_index<THEME_COUNT?theme_index:0];
    build();lv_obj_delete(blank);memset(shown_qr,0,sizeof(shown_qr));pet_ui_mem("theme-change");
}
static uint32_t ms(void){return (uint32_t)(esp_timer_get_time()/1000);}
static void ui_task(void *arg){
    (void)arg;input_t event;unsigned tick=0,last_page=0;int soc=-1;char status[64];uint32_t last_metrics_ms=0,last_key_ms=ms();
    for(;;){
        if(xQueueReceive(keys,&event,pdMS_TO_TICKS(250))==pdTRUE){input(&event);last_key_ms=ms();}
        while(xQueueReceive(keys,&event,0)==pdTRUE){input(&event);last_key_ms=ms();}
        pet_runtime_ui_state(keys_seen,page_index,menu,details);pet_runtime_copy(&view,status,sizeof(status));
        pet_runtime_open_copy(&action_view);
        if(action_view.phase!=shown_action_phase){shown_action_phase=action_view.phase;action_choice=false;}
        if(tick++%40==0)soc=bsp_battery_soc();
        bool modal=menu||settings_confirmation||action_dialog||info_page||pet_provision_active()||pet_runtime_setup_pending()||pet_runtime_link_requested();
        if(!desk_mode&&!view.public_mode&&pet_desk_due(ms(),last_key_ms,modal,page_index))desk_mode=true;
        if(desk_mode&&(modal||view.public_mode))desk_mode=false;
        if(bsp_lvgl_lock(100)){
            if(theme_dirty){theme_dirty=false;rebuild_theme();}
            fx_observe(ms());
            render(status,soc);
            uint32_t now=ms();
            if(page_index!=last_page&&now-last_metrics_ms>=1000){pet_ui_mem("page-change");last_metrics_ms=now;}
            last_page=page_index;bsp_lvgl_unlock();
        }
    }
}
void app_main(void){
    keys=xQueueCreate(8,sizeof(input_t));if(!keys){ESP_LOGE("pet","Input allocation failed");return;}
    if(esp_sleep_get_wakeup_cause()==ESP_SLEEP_WAKEUP_GPIO)key_guard_arm(&guard,esp_timer_get_time(),10000000);
    bsp_i2c_init();if(bsp_display_init()!=ESP_OK||!bsp_lvgl_init()){ESP_LOGE("pet","Display unavailable");return;}
    bsp_display_backlight(70);bsp_battery_init();pet_runtime_start();
    theme_index=pet_runtime_theme();if(theme_index>=THEME_COUNT)theme_index=0;theme=&themes[theme_index];
    if(!bsp_lvgl_lock(1000)){ESP_LOGE("pet","UI startup lock failed");return;}
    build();
    pet_ui_mem("build");
    lv_display_add_event_cb(lv_display_get_default(),first_render_completed,LV_EVENT_RENDER_READY,NULL);
    bsp_lvgl_unlock();
    if(bsp_button_init(on_key,NULL)!=ESP_OK)ESP_LOGE("pet","Buttons unavailable");
    key_guard_sync_released(&guard,bsp_button_read_mv()>=BSP_BTN_MV_RELEASED_MIN);
    if(xTaskCreate(ui_task,"pet_ui",4096,NULL,3,NULL)!=pdPASS)ESP_LOGE("pet","UI worker allocation failed");
}
