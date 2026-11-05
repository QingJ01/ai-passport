/* Agent Pet: original vector whale and a bounded four-page companion UI.
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
#include "pet_font_cjk_16.h"
#include "pet_font_ui_14.h"
#include "pet_font_ui_24.h"
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


typedef struct { bsp_btn_t button; bsp_btn_ev_t event; } input_t;
static QueueHandle_t keys;
static key_guard_t guard;
static lv_obj_t *screen,*heading,*health,*battery,*body,*detail,*footer,*whale,*eye,*pupil,*splash,*qr,*body_panel;
static lv_obj_t *hero,*hero_primary,*hero_secondary,*section,*status_dot,*menu_focus,*nav_mark,*usage_value;
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
#define BG 0x0F1A24
#define CARD 0x182938
#define FOCUS 0x24465C
#define BORDER 0x284052
#define INK 0xEEF4F8
#define MUTED 0x8EA4B6
#define ACCENT 0x8FE3CB
#define BLUE 0x568CFF
#define AMBER 0xFFC978
#define RED 0xFF9A8F
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
#define WHALE_X 20
#define WHALE_Y 96
#define SPLASH_X 57
#define SPLASH_Y 88
static const char *tabs[]={"概览","任务","用量","消息"};
typedef enum { M_PHONE,M_USB,M_PRIVACY,M_LOCAL,M_RELAY,M_PICK,M_OPEN,M_REQUEST,M_ABOUT,M_ADVANCED,M_BACK } menu_action_t;
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
static void panel_border(lv_obj_t *o){lv_obj_set_style_border_width(o,1,0);lv_obj_set_style_border_color(o,lv_color_hex(BORDER),0);}
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
static void build(void){
    screen=lv_obj_create(NULL);lv_obj_remove_style_all(screen);lv_obj_remove_flag(screen,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(screen,lv_color_hex(BG),0);lv_obj_set_style_bg_opa(screen,LV_OPA_COVER,0);
    heading=label_at(screen,18,9,148,34,F_TITLE,INK);
    battery=label_at(screen,166,17,58,20,F_SMALL,MUTED);lv_obj_set_style_text_align(battery,LV_TEXT_ALIGN_RIGHT,0);
    status_dot=shape(screen,19,52,6,6,MUTED,3);
    health=label_at(screen,31,45,193,20,F_SMALL,MUTED);
    hero=shape(screen,PANEL_X,PANEL_Y,PANEL_W,92,CARD,18);panel_border(hero);
    /* About one third smaller than the initial pet. No transformed layers. */
    whale=shape(screen,WHALE_X,WHALE_Y,102,62,BG,0);lv_obj_set_style_bg_opa(whale,LV_OPA_TRANSP,0);
    /* A single raised fluke reads cleanly at this size. */
    shape(whale,79,1,21,30,BLUE,10);
    shape(whale,0,12,84,49,BLUE,24);
    shape(whale,17,45,54,13,0xA6D2FF,7);shape(whale,45,52,16,10,0x3C6CD5,5);
    eye=shape(whale,20,28,5,7,0xFFFFFF,3);pupil=shape(eye,0,1,2,4,BG,2);
    shape(whale,19,40,7,2,BG,1);
    splash=shape(screen,SPLASH_X,SPLASH_Y,4,7,0x8EDDF3,2);
    hero_primary=label_at(screen,124,88,98,34,F_TITLE,INK);
    hero_secondary=label_at(screen,124,126,98,22,F_BODY,MUTED);
    body_panel=shape(screen,PANEL_X,HOME_PANEL_Y,PANEL_W,HOME_PANEL_H,CARD,18);panel_border(body_panel);
    menu_focus=shape(body_panel,6,ROW_TOP,204,35,FOCUS,10);hide(menu_focus,true);
    section=label_at(body_panel,14,10,188,20,F_SMALL,ACCENT);
    body=label_at(body_panel,14,34,188,44,F_BODY,INK);
    detail=label_at(body_panel,14,112,188,46,F_BODY,ACCENT);hide(detail,true);
    usage_value=label_at(body_panel,14,36,188,34,F_TITLE,INK);hide(usage_value,true);
    for(unsigned i=0;i<ROW_COUNT;i++){rows[i]=label_at(body_panel,16,ROW_TOP+7+(int)i*ROW_PITCH,184,22,F_BODY,INK);hide(rows[i],true);}
    for(unsigned i=0;i<4;i++){
        nav[i]=label_at(screen,10+(int)i*55,262,55,20,F_SMALL,MUTED);
        lv_obj_set_style_text_align(nav[i],LV_TEXT_ALIGN_CENTER,0);lv_label_set_text(nav[i],tabs[i]);
    }
    nav_mark=shape(screen,28,284,20,3,ACCENT,2);
    footer=label_at(screen,16,293,208,20,F_SMALL,MUTED);lv_obj_set_style_text_align(footer,LV_TEXT_ALIGN_CENTER,0);
    qr=lv_qrcode_create(screen);lv_qrcode_set_size(qr,168);lv_obj_set_pos(qr,36,80);
    lv_qrcode_set_dark_color(qr,lv_color_hex(BG));lv_qrcode_set_light_color(qr,lv_color_hex(0xFFFFFF));hide(qr,true);
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
    lv_obj_set_pos(menu_focus,6,top+(int)cursor*ROW_PITCH);hide(menu_focus,false);
}
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
    lv_obj_set_pos(menu_focus,6,ROW_TOP+(int)(cursor-start)*ROW_PITCH);hide(menu_focus,false);
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
    char text[640];hide(qr,true);hide(hero,true);hide(whale,true);hide(splash,true);
    hide(hero_primary,true);hide(hero_secondary,true);hide(menu_focus,true);hide(section,false);hide(body,false);
    hide(usage_value,true);hide(detail,true);
    for(unsigned i=0;i<ROW_COUNT;i++)hide(rows[i],true);
    bool modal=menu||settings_confirmation||action_dialog||info_page||pet_provision_active()||pet_runtime_setup_pending();
    for(unsigned i=0;i<4;i++){hide(nav[i],modal);color(nav[i],i==page_index?ACCENT:MUTED);}
    hide(nav_mark,modal);lv_obj_set_x(nav_mark,28+(int)page_index*55);
    lv_label_set_text(heading,tabs[page_index]);
    if(soc<0)lv_label_set_text(battery,"--%");else lv_label_set_text_fmt(battery,"%d%%",soc);
    bool fresh=view.current.valid&&view.current.source_connected&&view.current.source_fresh;
    lv_obj_set_style_bg_color(status_dot,lv_color_hex(fresh?ACCENT:view.current.valid?AMBER:MUTED),0);
    color(health,MUTED);color(body,INK);
    lv_label_set_text(health,pet_text_status(status,fresh,view.transport==PET_TRANSPORT_REMOTE));
    unsigned usb_seconds=pet_runtime_setup_seconds();
    if(usb_seconds){
        lv_label_set_text_fmt(health,fresh?"USB 实时同步・剩 %u 秒":"USB 已开放・剩 %u 秒",usb_seconds);
        color(health,ACCENT);lv_obj_set_style_bg_color(status_dot,lv_color_hex(fresh?ACCENT:BLUE),0);
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
    if(pet_runtime_setup_pending()&&!menu){
        lv_label_set_text(heading,"USB 连接");full_panel("确认连接",MODAL_PANEL_H);
        lv_label_set_text(body,"要应用电脑发来的设置吗？\n\n只有你自己发起的设置\n才可以继续。");
        lv_label_set_text(footer,"OK 应用・长按 OK 拒绝");return;
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
        snprintf(text,sizeof(text),"固件版本 0.2-dev\n连接方式：%s\n最多保存 3 个 Wi-Fi\n支持本地和中继两种服务",view.transport==PET_TRANSPORT_REMOTE?"中继服务":"本地服务");
        lv_label_set_text(body,text);
        lv_label_set_text(footer,"OK 返回菜单");return;
    }
    if(menu){render_menu();return;}
    if(view.public_mode){
        full_panel("公开模式",PAGE_PANEL_H);
        lv_label_set_text(body,"私密内容已隐藏。\n\n长按 OK 打开菜单，\n在“隐私模式”中关闭。");
        lv_label_set_text(footer,"上下翻页・长按 OK 菜单");return;
    }
    if(page_index==0){
        hide(hero,false);hide(whale,false);hide(splash,false);hide(hero_primary,false);hide(hero_secondary,false);
        lv_obj_set_height(body_panel,HOME_PANEL_H);lv_obj_set_pos(body,14,34);lv_obj_set_height(body,44);
        unsigned running=0,waiting=0;int best=-1,rank=-1;
        for(unsigned i=0;i<view.current.task_count;i++){pet_task_t *task=&view.current.tasks[i];running+=task->running;waiting+=task->waiting;int r=task->waiting?3:task->running?2:task->state==PET_FAILED?1:0;if(r>rank){best=(int)i;rank=r;}}
        lv_obj_set_style_bg_color(splash,lv_color_hex(waiting?AMBER:0x8EDDF3),0);
        color(hero_secondary,MUTED);
        if(!view.current.valid){
            lv_label_set_text(hero_primary,"你好");lv_label_set_text(hero_secondary,"先来连接吧");
            lv_label_set_text(section,"开始使用");lv_label_set_text(body,"按 OK 连接手机或电脑，\n任务会显示在这里。");
        }else{
            if(waiting){lv_label_set_text(hero_primary,"等你处理");lv_label_set_text_fmt(hero_secondary,"%u 件待回复",waiting);color(hero_secondary,AMBER);}
            else if(running){lv_label_set_text(hero_primary,"忙碌中");lv_label_set_text_fmt(hero_secondary,"%u 个进行中",running);color(hero_secondary,ACCENT);}
            else{lv_label_set_text(hero_primary,"很安静");lv_label_set_text(hero_secondary,fresh?"已是最新":"上次的数据");}
            lv_label_set_text(section,waiting?"需要你处理":best>=0&&rank>=2?"当前任务":best>=0?"最近的任务":"一切就绪");
            lv_label_set_text(body,best>=0?display_text(view.current.tasks[best].title):"新任务会显示在这里。");
        }
        lv_label_set_text(footer,view.current.task_count?"OK 查看任务・长按 OK 菜单":"OK 开始连接・长按 OK 菜单");return;
    }
    full_panel("",PAGE_PANEL_H);
    if(page_index==1){
        pet_task_t *task=selected_task();
        if(!task){lv_label_set_text(section,"还没有任务");lv_label_set_text(body,"连接电脑后，\n这里会实时显示任务。");}
        else{
            if(view.current.total_tasks>view.current.task_count)lv_label_set_text_fmt(section,"第 %u/%u 个・电脑上共 %lu 个",selected+1,view.current.task_count,(unsigned long)view.current.total_tasks);
            else lv_label_set_text_fmt(section,"第 %u/%u 个",selected+1,view.current.task_count);
            lv_obj_set_height(body,68);lv_label_set_text(body,display_text(task->title));
            hide(detail,false);lv_obj_set_pos(detail,14,112);
            color(detail,task->waiting?AMBER:task->running?ACCENT:task->state==PET_FAILED?RED:MUTED);
            snprintf(text,sizeof(text),"%s\n%s",pet_text_task_state(task),task->goal_completed?"已报告完成":"结果未报告");
            lv_label_set_text(detail,text);
        }
        lv_label_set_text(footer,view.current.task_count>1?"OK 下一个・长按 OK 菜单":view.current.task_count?"OK 在电脑上打开・长按菜单":"OK 开始连接・长按 OK 菜单");return;
    }
    if(page_index==2){
        if(details){
            const char *source=view.current.usage_known?pet_text_provenance(view.current.provenance):"暂无来源";
            lv_label_set_text(section,"数据来源");
            snprintf(text,sizeof(text),"%s\n\n只统计已加载的会话，\n不含费用和额度。",source?source:display_text(view.current.provenance));
            lv_label_set_text(body,text);
        }else{
            char grouped[40];pet_text_group_digits(view.current.tokens,grouped,sizeof(grouped));
            lv_label_set_text(section,"累计 Token");hide(usage_value,false);
            lv_label_set_text(usage_value,view.current.usage_known?grouped:"--");
            lv_obj_set_pos(body,14,84);lv_obj_set_height(body,66);
            lv_label_set_text(body,view.current.usage_known?"只统计已加载的会话，\n不含费用。":"还没有可验证的用量，\n连接电脑后显示。");
        }
        lv_label_set_text(footer,details?"OK 返回总数・长按 OK 菜单":"OK 查看来源・长按 OK 菜单");return;
    }
    if(!view.current.inbox_count){lv_label_set_text(section,"没有新消息");lv_label_set_text(body,"都处理完了。\n新的提醒会出现在这里。");}
    else{if(selected>=view.current.inbox_count)selected=0;lv_label_set_text_fmt(section,"第 %u/%u 条",selected+1,view.current.inbox_count);lv_label_set_text(body,display_text(pet_text_inbox(view.current.inbox[selected])));}
    lv_label_set_text(footer,view.current.inbox_count>1?"OK 下一条・长按 OK 菜单":"上下翻页・长按 OK 菜单");
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
    if(event->event==BSP_BTN_LONG){
        if(event->button==BSP_BTN_OK){
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
            case M_ABOUT:info_page=true;menu=false;break;
            case M_ADVANCED:advanced=true;menu_selection=0;break;
            case M_BACK:menu=false;break;
        }
        return;
    }
    if(arrow){page_index=(page_index+(direction<0?3:1))%4;selected=0;selected_task_id[0]=0;details=false;return;}
    if(view.public_mode){menu=true;menu_selection=M_PRIVACY;return;}
    if(page_index==0){if(view.current.task_count){page_index=1;unsigned best=0;int rank=-1;for(unsigned i=0;i<view.current.task_count;i++){pet_task_t *task=&view.current.tasks[i];int r=task->waiting?3:task->running?2:task->state==PET_FAILED?1:0;if(r>rank){best=i;rank=r;}}remember_task(best);}else{menu=true;menu_selection=0;}return;}
    if(page_index==1){if(!view.current.task_count){menu=true;menu_selection=0;}else if(view.current.task_count>1)remember_task((selected+1)%view.current.task_count);else open_dialog();return;}
    if(page_index==2){details=!details;return;}
    if(view.current.inbox_count)selected=(selected+1)%view.current.inbox_count;
}
static void ui_task(void *arg){
    (void)arg;input_t event;unsigned tick=0,last_page=0;int soc=-1;char status[64];uint32_t last_metrics_ms=0;
    for(;;){
        if(xQueueReceive(keys,&event,pdMS_TO_TICKS(250))==pdTRUE)input(&event);
        while(xQueueReceive(keys,&event,0)==pdTRUE)input(&event);
        pet_runtime_ui_state(keys_seen,page_index,menu,details);pet_runtime_copy(&view,status,sizeof(status));
        pet_runtime_open_copy(&action_view);
        if(action_view.phase!=shown_action_phase){shown_action_phase=action_view.phase;action_choice=false;}
        if(tick++%40==0)soc=bsp_battery_soc();
        if(bsp_lvgl_lock(100)){
            render(status,soc);
            if(!menu&&!details&&page_index==0){lv_obj_set_y(whale,WHALE_Y+(tick%12<6?0:1));lv_obj_set_y(splash,SPLASH_Y+(tick%12<6?0:1));bool blink=tick%36==0;lv_obj_set_height(eye,blink?2:7);hide(pupil,blink);}
            uint32_t now=(uint32_t)(esp_timer_get_time()/1000);
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
    if(!bsp_lvgl_lock(1000)){ESP_LOGE("pet","UI startup lock failed");return;}
    build();
    pet_ui_mem("build");
    lv_display_add_event_cb(lv_display_get_default(),first_render_completed,LV_EVENT_RENDER_READY,NULL);
    bsp_lvgl_unlock();
    if(bsp_button_init(on_key,NULL)!=ESP_OK)ESP_LOGE("pet","Buttons unavailable");
    key_guard_sync_released(&guard,bsp_button_read_mv()>=BSP_BTN_MV_RELEASED_MIN);
    if(xTaskCreate(ui_task,"pet_ui",4096,NULL,3,NULL)!=pdPASS)ESP_LOGE("pet","UI worker allocation failed");
}
