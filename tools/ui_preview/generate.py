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
#include "pet_font_cjk_16.h"
#include "bsp_button.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
bool pet_provision_active(void){return false;}
bool pet_provision_qr(char *out,size_t n){(void)out;(void)n;return false;}
bool pet_runtime_setup_pending(void){return false;}
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
static void snapshot(const char *filename){
    lv_obj_invalidate(screen);lv_refr_now(NULL);
    FILE*f=fopen(filename,"wb");if(!f)exit(2);fwrite(pixels,1,sizeof(pixels),f);fclose(f);
}
int main(int argc,char **argv){
    if(argc==2&&!strcmp(argv[1],"--smoke")){input_smoke();return 0;}
    if(argc!=2)return 2;lv_init();lv_display_t*d=lv_display_create(240,320);
    lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d,draw_buffer,NULL,sizeof(draw_buffer),LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(d,flush);build();
    char path[1024];
    memset(&view,0,sizeof(view));page_index=0;render("Not configured",-1);
    snprintf(path,sizeof(path),"%s/now.rgb",argv[1]);snapshot(path);
    view.current.valid=true;view.current.source_connected=true;view.current.source_fresh=true;
    view.current.task_count=2;view.current.tasks[0]=(pet_task_t){.id="fixture-task-1",.title="Review the new dashboard",.state=PET_RUNNING,.running=true};
    view.current.tasks[1]=(pet_task_t){.id="fixture-task-2",.title="Check the pairing flow",.state=PET_WAITING,.waiting=true};
    page_index=1;render("Service synchronized",84);
    snprintf(path,sizeof(path),"%s/tasks.rgb",argv[1]);snapshot(path);
    memset(&view,0,sizeof(view));page_index=0;menu=true;menu_selection=0;render("Not configured",-1);
    snprintf(path,sizeof(path),"%s/menu.rgb",argv[1]);snapshot(path);
    memset(&view,0,sizeof(view));view.current.valid=true;view.current.source_connected=true;
    view.current.source_fresh=true;view.current.usage_known=true;
    strcpy(view.current.tokens,"184,206");strcpy(view.current.provenance,"Magpie desktop session");
    page_index=2;menu=false;advanced=false;task_picker=false;render("Service synchronized",84);
    snprintf(path,sizeof(path),"%s/usage.rgb",argv[1]);snapshot(path);
    memset(&view,0,sizeof(view));view.current.valid=true;view.current.source_connected=true;
    view.current.source_fresh=true;view.current.inbox_count=2;
    strcpy(view.current.inbox[0],"Pairing guide is ready to review");
    strcpy(view.current.inbox[1],"Usage source changed to desktop");
    page_index=3;menu=false;advanced=false;task_picker=false;render("Service synchronized",84);
    snprintf(path,sizeof(path),"%s/inbox.rgb",argv[1]);snapshot(path);
    return 0;
}
'''
(out/'preview.c').write_text('/* HOST RENDER; main.c SHA256 '+sha+' */\n'+header+globals+ui+inputs+smoke+footer)
(out/'source.json').write_text(json.dumps({'main_sha256':sha,'renderer':'actual LVGL 9.5.0 host RGB565; 240x320; no ESP device execution','now':'Unpaired default state; unknown battery','tasks':'SYNTHETIC FIXTURE: two tasks, first running, battery84','menu':'Unpaired default menu; first of three visible rows selected','usage':'SYNTHETIC FIXTURE: 184,206 lifetime tokens, desktop session source, battery84','inbox':'SYNTHETIC FIXTURE: two updates, first shown, battery84'},indent=2))
print('Extracted main.c SHA256',sha)
