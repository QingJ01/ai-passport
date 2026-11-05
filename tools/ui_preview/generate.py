from pathlib import Path
import hashlib,json,struct,zlib
root=Path(__file__).resolve().parents[2]
out=Path(__file__).resolve().parent
source=(root/'main/main.c').read_text()
sha=hashlib.sha256(source.encode()).hexdigest()
globals=source[source.index('static lv_obj_t *screen'):source.index('static size_t pet_ui_object_count')]
ui=source[source.index('static void hide('):source.index('static void on_key(')]
header='''#include "lvgl.h"
#include "agent_pet_runtime.h"
#include "agent_pet_provisioning.h"
#include "agent_pet_text.h"
#include "pet_font_cjk_16.h"
#include "pet_font_ui_14.h"
#include "pet_font_ui_24.h"
#include "bsp_button.h"
#include "bsp_display_rounding.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
bool pet_provision_active(void){return false;}
bool pet_provision_qr(char *out,size_t n){(void)out;(void)n;return false;}
bool pet_runtime_setup_pending(void){return false;}
unsigned pet_runtime_setup_seconds(void){return 0;}
bool pet_runtime_open_prepare(const char *id){(void)id;return false;}
static unsigned settings_calls;
void pet_runtime_open_cancel(void){}
bool pet_runtime_open_confirm(void){return false;}
bool pet_runtime_open_query(void){return false;}
void pet_provision_stop(void){}
void pet_provision_confirm(void){}
esp_err_t pet_provision_start(void){return ESP_OK;}
void pet_runtime_cancel_setup(void){}
void pet_runtime_confirm(void){}
void pet_runtime_settings_action(pet_settings_action_t a){(void)a;settings_calls++;}
void pet_runtime_setup_window(void){}
void pet_runtime_privacy(bool b){(void)b;}
bool pet_runtime_select_transport(pet_transport_t t){(void)t;return false;}
typedef struct { bsp_btn_t button; bsp_btn_ev_t event; } input_t;
'''
inputs=source[source.index('static void close_action('):source.index('static void ui_task(')]
smoke=r"""
static void press(bsp_btn_t b,bsp_btn_ev_t e){input_t k={b,e};input(&k);}
static void reset_state(void){
    memset(&view,0,sizeof(view));page_index=0;selected=0;selected_task_id[0]=0;
    menu=false;advanced=false;details=false;task_picker=false;action_dialog=false;
    action_unavailable=false;action_choice=false;info_page=false;settings_confirmation=0;
    phone_enabled=false;confirm_yes=false;keys_seen=0;menu_selection=0;picker_index=0;
}
static void input_smoke(void){
    reset_state();
    press(BSP_BTN_UP,BSP_BTN_CLICK);assert(page_index==3);
    press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page_index==0);
    details=true;press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page_index==1&&!details);
    reset_state();press(BSP_BTN_OK,BSP_BTN_CLICK);assert(menu&&menu_selection==0);
    press(BSP_BTN_OK,BSP_BTN_LONG);assert(!menu);
    reset_state();menu=true;menu_selection=0;press(BSP_BTN_UP,BSP_BTN_CLICK);
    assert(menu_selection==(unsigned)ENTRY_COUNT-1);
    press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(menu_selection==0);
    reset_state();menu=true;menu_selection=M_ADVANCED;press(BSP_BTN_OK,BSP_BTN_CLICK);
    assert(advanced&&menu_selection==0);
    press(BSP_BTN_UP,BSP_BTN_CLICK);assert(menu_selection==4);
    press(BSP_BTN_OK,BSP_BTN_CLICK);assert(!advanced&&menu_selection==M_ADVANCED);
    reset_state();view.current.task_count=2;
    strcpy(view.current.tasks[0].id,"first");strcpy(view.current.tasks[1].id,"second");
    page_index=1;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(selected==1&&!strcmp(selected_task_id,"second"));
    press(BSP_BTN_OK,BSP_BTN_CLICK);assert(selected==0&&!strcmp(selected_task_id,"first"));
    reset_state();view.current.task_count=1;strcpy(view.current.tasks[0].id,"only");
    page_index=1;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(action_dialog&&!menu);
    reset_state();menu=true;advanced=true;menu_selection=0;press(BSP_BTN_OK,BSP_BTN_CLICK);
    assert(settings_confirmation==PET_SETTINGS_FORGET_WIFI&&!confirm_yes);
    press(BSP_BTN_OK,BSP_BTN_CLICK);
    assert(settings_calls==0&&settings_confirmation==0&&!menu);
    reset_state();menu=true;advanced=true;menu_selection=1;press(BSP_BTN_OK,BSP_BTN_CLICK);
    press(BSP_BTN_UP,BSP_BTN_CLICK);assert(confirm_yes);
    press(BSP_BTN_OK,BSP_BTN_CLICK);assert(settings_calls==1&&!menu);
    reset_state();info_page=true;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(!info_page&&menu);
    puts("Actual input() smoke PASS: paging, empty-Now menu, hold-back, menu wrap, advanced submenu, task cycling, single-task dialog, Cancel default, confirmed action, info return");
}
"""

footer=r'''
static uint16_t draw_buffer[240*320];
static unsigned char pixels[240*320*3];
static void flush(lv_display_t *display,const lv_area_t *area,uint8_t *map){
    int width=area->x2-area->x1+1;
    uint16_t *p=(uint16_t*)map;
    for(int y=area->y1;y<=area->y2;y++)for(int x=area->x1;x<=area->x2;x++){
        uint16_t c=p[(y-area->y1)*width+x-area->x1];
        unsigned char *q=&pixels[(y*240+x)*3];
        q[0]=((c>>11)&31)*255/31;q[1]=((c>>5)&63)*255/63;q[2]=(c&31)*255/31;
    }
    lv_display_flush_ready(display);
}
/* Same black corner mask the board applies in bsp_display_lvgl.c. */
static void round_corners(void){
    for(int y=0;y<320;y++){int32_t x1,x2;bool visible=bsp_display_rounded_row_span(y,240,320,30,&x1,&x2);
        for(int x=0;x<240;x++)if(!visible||x<x1||x>x2)memset(&pixels[(y*240+x)*3],0,3);}
}
static void snapshot(const char *filename){
    lv_obj_invalidate(screen);lv_refr_now(NULL);round_corners();
    FILE*f=fopen(filename,"wb");if(!f)exit(2);fwrite(pixels,1,sizeof(pixels),f);fclose(f);
}
int main(int argc,char **argv){
    if(argc==2&&!strcmp(argv[1],"--smoke")){input_smoke();return 0;}
    if(argc!=2)return 2;lv_init();lv_display_t*d=lv_display_create(240,320);
    lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d,draw_buffer,NULL,sizeof(draw_buffer),LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(d,flush);build();
    char path[1024];
#define SHOT(name) do{snprintf(path,sizeof(path),"%s/" name ".rgb",argv[1]);snapshot(path);}while(0)
#define LIVE() do{memset(&view,0,sizeof(view));view.current.valid=true;view.current.source_connected=true;view.current.source_fresh=true;}while(0)
    reset_state();render("Not configured",-1);SHOT("now");
    reset_state();LIVE();view.current.task_count=3;view.current.total_tasks=3;
    view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="整理本周的设计评审意见",.state=PET_WAITING,.running=true,.waiting=true};
    view.current.tasks[1]=(pet_task_t){.id="fixture-task-2",.title="Check the pairing flow",.state=PET_RUNNING,.running=true};
    view.current.tasks[2]=(pet_task_t){.id="fixture-task-3",.title="更新网站首页",.state=PET_COMPLETED,.goal_completed=true};
    render("Service synchronized",84);SHOT("now-live");
    reset_state();LIVE();view.current.task_count=2;view.current.total_tasks=20;
    view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="整理本周的设计评审意见并汇总给团队",.state=PET_RUNNING,.running=true};
    view.current.tasks[1]=(pet_task_t){.id="fixture-task-2",.title="Check the pairing flow",.state=PET_WAITING,.waiting=true};
    page_index=1;render("Service synchronized",84);SHOT("tasks");
    reset_state();menu=true;menu_selection=3;render("Not configured",-1);SHOT("menu");
    reset_state();LIVE();view.current.usage_known=true;
    strcpy(view.current.tokens,"184206");strcpy(view.current.provenance,"host-reduced-records");
    page_index=2;render("Service synchronized",84);SHOT("usage");
    reset_state();LIVE();view.current.inbox_count=2;
    strcpy(view.current.inbox[0],"Input requested");strcpy(view.current.inbox[1],"配对指南已经可以查看");
    page_index=3;render("Service synchronized",84);SHOT("inbox");
    reset_state();menu=true;advanced=true;settings_confirmation=PET_SETTINGS_FORGET_WIFI;render("Not configured",72);SHOT("confirm");
    reset_state();LIVE();action_dialog=true;memset(&action_view,0,sizeof(action_view));
    action_view.phase=PET_ACTION_READY;action_view.can_confirm=true;strcpy(action_view.target_id,"fixture-task-1");
    strcpy(action_view.title,"整理本周的设计评审意见");action_choice=true;render("Service synchronized",84);SHOT("action");
    return 0;
}
'''
(out/'preview.c').write_text('/* HOST RENDER; main.c SHA256 '+sha+' */\n'+header+globals+ui+inputs+smoke+footer)
(out/'source.json').write_text(json.dumps({'main_sha256':sha,'renderer':'actual LVGL 9.5.0 host RGB565; 240x320; no ESP device execution','now':'Unpaired default state; unknown battery','now-live':'SYNTHETIC FIXTURE: three tasks, one waiting, battery84','tasks':'SYNTHETIC FIXTURE: two of twenty tasks, first running, battery84','menu':'Unpaired default menu; fourth of eleven entries selected','usage':'SYNTHETIC FIXTURE: 184206 lifetime tokens, host-reduced source, battery84','inbox':'SYNTHETIC FIXTURE: two updates, first shown, battery84','confirm':'Forget Wi-Fi confirmation; Cancel selected by default','action':'SYNTHETIC FIXTURE: open-on-computer offer ready, Open highlighted'},indent=2))
print('Extracted main.c SHA256',sha)
