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
#include "agent_pet_mood.h"
#include "pet_font_num_40.h"
#include <stdlib.h>
#include "pet_font_cjk_16.h"
#include "pet_font_ui_14.h"
#include "pet_font_ui_24.h"
#include "pet_whale_img.h"
#include "pet_critter_img.h"
#include "pet_pixel.h"
#include "bsp_button.h"
#include "bsp_display_rounding.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
bool pet_provision_active(void){return false;}
bool pet_provision_qr(char *out,size_t n){(void)out;(void)n;return false;}
static bool preview_setup;
bool pet_runtime_setup_pending(void){return preview_setup;}
bool pet_runtime_setup_ssid(char *out,size_t n){snprintf(out,n,"%s",preview_setup?"MyHome-2.4G":"");return preview_setup;}
unsigned pet_runtime_setup_seconds(void){return 0;}
static uint8_t preview_theme;
uint8_t pet_runtime_theme(void){return preview_theme;}
void pet_runtime_set_theme(uint8_t t){preview_theme=t;}
static void pet_ui_mem(const char *why){(void)why;}
static int64_t esp_timer_get_time(void){return 0;}
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
static unsigned setup_calls,dismiss_calls;static bool preview_link;
void pet_runtime_setup_window(void){setup_calls++;preview_link=false;}
bool pet_runtime_link_requested(void){return preview_link;}
void pet_runtime_link_dismiss(void){dismiss_calls++;preview_link=false;}
void pet_runtime_privacy(bool b){(void)b;}
bool pet_runtime_select_transport(pet_transport_t t){(void)t;return false;}
typedef struct { bsp_btn_t button; bsp_btn_ev_t event; } input_t;
'''
inputs=source[source.index('static void close_action('):source.index('static void ui_task(')]
smoke=r"""
static void press(bsp_btn_t b,bsp_btn_ev_t e){input_t k={b,e};input(&k);}
static void reset_state(void){
    memset(&view,0,sizeof(view));page_index=0;selected=0;selected_task_id[0]=0;
    menu=false;advanced=false;details=false;task_picker=false;action_dialog=false;usage_page=0;
    action_unavailable=false;action_choice=false;info_page=false;settings_confirmation=0;
    phone_enabled=false;confirm_yes=false;keys_seen=0;menu_selection=0;picker_index=0;desk_mode=false;mood=PET_MOOD_IDLE;
}
static void input_smoke(void){
    reset_state();
    press(BSP_BTN_UP,BSP_BTN_CLICK);assert(page_index==3);
    press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page_index==0);
    details=true;press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(page_index==1&&!details);
    reset_state();setup_calls=0;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(!menu&&setup_calls==1);
    reset_state();view.current.valid=true;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(menu&&menu_selection==0);
    press(BSP_BTN_OK,BSP_BTN_LONG);assert(!menu);
    reset_state();setup_calls=0;preview_link=true;press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(preview_link&&page_index==0&&setup_calls==0);
    press(BSP_BTN_OK,BSP_BTN_CLICK);assert(!preview_link&&setup_calls==1&&!menu);
    reset_state();dismiss_calls=0;preview_link=true;press(BSP_BTN_OK,BSP_BTN_LONG);assert(!preview_link&&dismiss_calls==1&&!menu);
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
    reset_state();desk_mode=true;press(BSP_BTN_OK,BSP_BTN_CLICK);assert(!desk_mode&&!menu&&page_index==0);
    reset_state();desk_mode=true;press(BSP_BTN_DOWN,BSP_BTN_CLICK);assert(!desk_mode&&page_index==0);
    puts("Actual input() smoke PASS: paging, empty-Now menu, hold-back, menu wrap, advanced submenu, task cycling, single-task dialog, Cancel default, confirmed action, info return, desk wake consumes key, one-press USB link consent");
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
/* Real animations: the first placement and every later slide land on target,
 * including right after a theme rebuild (regression: zero-length first anim). */
static uint32_t fake_ms;static uint32_t fake_tick(void){return fake_ms;}
static void pump(unsigned ms){for(unsigned t=0;t<ms;t+=10){fake_ms+=10;lv_timer_handler();}}
static void motion_smoke(void){
    memset(&view,0,sizeof(view));view.current.valid=true;view.current.task_count=2;
    strcpy(view.current.tasks[0].id,"m1");strcpy(view.current.tasks[0].title,"one");
    strcpy(view.current.tasks[1].id,"m2");strcpy(view.current.tasks[1].title,"two");
    for(unsigned round=0;round<2;round++){
        page_index=0;render("Service synchronized",84);pump(300);assert(lv_obj_get_x(nav_mark)==PANEL_X+2);
        press(BSP_BTN_DOWN,BSP_BTN_CLICK);render("Service synchronized",84);pump(300);
        assert(lv_obj_get_x(nav_mark)==PANEL_X+2+53);assert(lv_obj_get_y(menu_focus)==LIST_TOP-2);
        press(BSP_BTN_OK,BSP_BTN_CLICK);render("Service synchronized",84);pump(300);assert(lv_obj_get_y(menu_focus)==LIST_TOP-2+LIST_PITCH);
        press(BSP_BTN_UP,BSP_BTN_CLICK);theme_index=(theme_index+1)%THEME_COUNT;rebuild_theme();
    }
    theme_index=0;rebuild_theme();page_index=0;selected=0;selected_task_id[0]=0;
    puts("Motion smoke PASS: tab pill and list highlight land on target, also after a theme rebuild");
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
    lv_display_set_flush_cb(d,flush);lv_tick_set_cb(fake_tick);build();
    motion_smoke();instant_motion=true;
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
    view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="整理本周的设计评审意见并汇总给团队",.state=PET_RUNNING,.running=true,.tokens="52340",.rate="38.5",.cost="$0.36",.cost_estimate=true,.agent="DeepSeek"};
    view.current.tasks[1]=(pet_task_t){.id="fixture-task-2",.title="Check the pairing flow",.state=PET_WAITING,.waiting=true};
    page_index=1;render("Service synchronized",84);SHOT("tasks");
    reset_state();menu=true;menu_selection=3;render("Not configured",-1);SHOT("menu");
    reset_state();LIVE();view.current.usage_known=true;
    strcpy(view.current.tokens,"18817828");strcpy(view.current.provenance,"magpie-today");strcpy(view.current.cost,"$130.1");view.current.cost_estimate=true;strcpy(view.current.rate,"53.2");
    {const char *rows[][3]={{"gpt-6.1-sol","9853240","$61.20"},{"deepseek-flash","6120440","$12.48"},{"claude-opus-5-5","2511830","$48.02"},{"swe-2","330112","$8.41"},{"gpt-6-luna","2210",""}};
     view.current.model_count=5;for(unsigned i=0;i<5;i++){strcpy(view.current.models[i].name,rows[i][0]);strcpy(view.current.models[i].tokens,rows[i][1]);strcpy(view.current.models[i].cost,rows[i][2]);}}
    page_index=2;render("Service synchronized",84);SHOT("usage");
    reset_state();LIVE();view.current.inbox_count=2;
    strcpy(view.current.inbox[0],"Input requested");strcpy(view.current.inbox[1],"配对指南已经可以查看");
    page_index=3;render("Service synchronized",84);SHOT("inbox");
    reset_state();menu=true;advanced=true;settings_confirmation=PET_SETTINGS_FORGET_WIFI;render("Not configured",72);SHOT("confirm");
    reset_state();LIVE();action_dialog=true;memset(&action_view,0,sizeof(action_view));
    action_view.phase=PET_ACTION_READY;action_view.can_confirm=true;strcpy(action_view.target_id,"fixture-task-1");
    strcpy(action_view.title,"整理本周的设计评审意见");action_choice=true;render("Service synchronized",84);SHOT("action");
#define DESK_FIXTURE() do{reset_state();LIVE();view.current.task_count=2;view.current.total_tasks=2;\
    view.current.tasks[0]=(pet_task_t){.id="t1",.title="整理本周的设计评审意见并汇总",.state=PET_RUNNING,.running=true,.agent="DeepSeek"};\
    view.current.tasks[1]=(pet_task_t){.id="t2",.title="Check the pairing flow",.state=PET_RUNNING,.running=true};\
    view.current.usage_known=true;strcpy(view.current.tokens,"18858491");strcpy(view.current.provenance,"magpie-today");\
    strcpy(view.current.rate,"77.9");strcpy(view.current.cost,"$134.6");view.current.cost_estimate=true;view.current.spark_count=30;\
    for(unsigned i=0;i<30;i++)view.current.spark[i]=(uint32_t)(800+((i*7919u)%13u)*420u+(i>22?4200u:0u));\
    memset(&mood_tracker,0,sizeof(mood_tracker));fx_observe(1000);odo_shown=odo_target-1;desk_mode=true;render("Service synchronized",84);\
    for(unsigned k=0;k<70;k++)fx_tick(NULL);}while(0)
    DESK_FIXTURE();SHOT("desk");
    reset_state();preview_link=true;render("Not configured",-1);SHOT("link");preview_link=false;
    reset_state();preview_setup=true;render("Setup received: press OK",-1);SHOT("wifi");preview_setup=false;
    reset_state();LIVE();view.current.task_count=1;view.current.tasks[0]=(pet_task_t){.id="t1",.title="重构设置页面",.state=PET_RUNNING,.running=true};
    render("Service synchronized",84);{pet_event_t ev={PET_EVENT_DONE,"重构设置页面"};show_toast(&ev);}SHOT("toast");toast_hide_now();
    theme_index=1;rebuild_theme();
    reset_state();LIVE();view.current.task_count=3;view.current.total_tasks=3;
    view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="重构设置页面",.state=PET_RUNNING,.running=true,.agent="Claude"};
    view.current.tasks[1]=(pet_task_t){.id="fixture-task-2",.title="Check the pairing flow",.state=PET_RUNNING,.running=true};
    view.current.tasks[2]=(pet_task_t){.id="fixture-task-3",.title="更新网站首页",.state=PET_COMPLETED,.goal_completed=true};
    render("Service synchronized",84);SHOT("now-claude");
    reset_state();LIVE();view.current.task_count=1;view.current.total_tasks=1;
    view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="重构设置页面并补充测试",.state=PET_RUNNING,.running=true,.tokens="1830000",.rate="61.4",.cost="$4.12",.cost_estimate=true,.agent="Claude"};
    page_index=1;render("Service synchronized",84);SHOT("tasks-claude");
    DESK_FIXTURE();SHOT("desk-claude");
    return 0;
}
'''
(out/'preview.c').write_text('/* HOST RENDER; main.c SHA256 '+sha+' */\n'+header+globals+ui+inputs+smoke+footer)
(out/'source.json').write_text(json.dumps({'main_sha256':sha,'renderer':'actual LVGL 9.5.0 host RGB565; 240x320; no ESP device execution','now':'Unpaired default state; unknown battery','now-live':'SYNTHETIC FIXTURE: three tasks, one waiting, battery84','tasks':'SYNTHETIC FIXTURE: two of twenty tasks, first running with estimated metrics, battery84','menu':'Unpaired default menu; fourth of eleven entries selected','usage':'SYNTHETIC FIXTURE: Magpie today totals with five models (first page), battery84','inbox':'SYNTHETIC FIXTURE: two updates, first shown, battery84','confirm':'Forget Wi-Fi confirmation; Cancel selected by default','action':'SYNTHETIC FIXTURE: open-on-computer offer ready, Open highlighted','now-claude':'SYNTHETIC FIXTURE: Claude Code theme overview, two running tasks, battery84','tasks-claude':'SYNTHETIC FIXTURE: Claude Code theme task card with metrics, battery84','desk':'SYNTHETIC FIXTURE: desk mode, whale working with particles, odometer and 30-minute activity','toast':'SYNTHETIC FIXTURE: task-finished banner over the overview','link':'USB link request: one-press consent prompt','wifi':'SYNTHETIC FIXTURE: Wi-Fi setup sent from the computer, confirmation prompt','desk-claude':'SYNTHETIC FIXTURE: desk mode, pixel critter working with sparks'},indent=2))
print('Extracted main.c SHA256',sha)
