/* Agent Pet: original vector whale and a bounded four-page companion UI. */
#include "bsp_i2c.h"
#include "bsp_display.h"
#include "bsp_button.h"
#include "bsp_battery.h"
#include "bsp_pins.h"
#include "agent_pet_runtime.h"
#include "agent_pet_provisioning.h"
#include "agent_pet_input.h"
#include "pet_font_cjk_16.h"
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
static lv_obj_t *screen,*heading,*health,*battery,*body,*footer,*whale,*eye,*pupil,*splash,*qr,*body_panel;
static lv_obj_t *hero,*hero_primary,*hero_secondary,*section,*status_dot,*menu_focus,*nav_mark,*usage_value;
static lv_obj_t *nav[4],*menu_rows[2];
static char qr_payload[1024],shown_qr[1024];
static pet_runtime_view_t view;
static pet_action_view_t action_view;
static unsigned page_index,selected,menu_selection,picker_index;
static bool details,menu,advanced,task_picker,info_page,confirm_yes,action_dialog,action_choice,action_unavailable,phone_enabled;
static char selected_task_id[PET_ID_MAX+1];
static pet_action_phase_t shown_action_phase;
static pet_settings_action_t settings_confirmation;
static uint32_t keys_seen;
#define BG 0x101B25
#define CARD 0x1B2B3A
#define INK 0xEDF4F8
#define MUTED 0x8FA7B9
#define ACCENT 0x9FE4D0
#define BLUE 0x568CFF
#define AMBER 0xFFCE86
static const char *pages[]={"Your day","Tasks","Usage","Inbox"};
static const char *tabs[]={"Now","Tasks","Usage","Inbox"};
typedef enum { M_PHONE,M_USB,M_PRIVACY,M_LOCAL,M_RELAY,M_PICK,M_OPEN,M_REQUEST,M_ABOUT,M_ADVANCED,M_BACK } menu_action_t;
typedef struct { const char *title,*hint; menu_action_t action; } menu_entry_t;
static const menu_entry_t entries[]={
    {"Pair with phone","Secure pairing for 120s",M_PHONE},
    {"Connect over USB","Open a 120-second window",M_USB},
    {"Privacy","Choose what others can see",M_PRIVACY},
    {"Use local service","Keep your relay link saved",M_LOCAL},
    {"Use relay service","Read updates away from home",M_RELAY},
    {"Choose a task","Select a received task",M_PICK},
    {"Open on computer","You confirm before opening",M_OPEN},
    {"Request status","Check the last open request",M_REQUEST},
    {"Device information","About your companion",M_ABOUT},
    {"Device settings","Wi-Fi, pairing and reset",M_ADVANCED},
    {"Back","Return to your day",M_BACK}
};
static const char *advanced_titles[]={"Forget Wi-Fi","Unpair local service","Forget relay service","Reset Agent Pet","Back"};
static const char *advanced_hints[]={"Saved service links stay","Wi-Fi and relay stay","Wi-Fi and local link stay","Clear this app's settings","Return to the menu"};
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
    lv_obj_set_style_text_line_space(o,3,0);lv_label_set_long_mode(o,LV_LABEL_LONG_DOT);return o;
}
static void panel_border(lv_obj_t *o){lv_obj_set_style_border_width(o,1,0);lv_obj_set_style_border_color(o,lv_color_hex(0x2A3C4E),0);}
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
    heading=label_at(screen,16,15,158,28,&lv_font_montserrat_20,INK);
    battery=label_at(screen,181,20,44,20,&lv_font_montserrat_14,MUTED);lv_obj_set_style_text_align(battery,LV_TEXT_ALIGN_RIGHT,0);
    status_dot=shape(screen,17,51,5,5,MUTED,3);
    health=label_at(screen,28,44,196,20,&lv_font_montserrat_14,MUTED);
    hero=shape(screen,12,73,216,88,CARD,16);panel_border(hero);
    /* About one third smaller than the initial pet. No transformed layers. */
    whale=shape(screen,27,95,102,62,BG,0);lv_obj_set_style_bg_opa(whale,LV_OPA_TRANSP,0);
    /* A single raised fluke reads cleanly at this size. */
    shape(whale,79,1,21,30,BLUE,10);
    shape(whale,0,12,84,49,BLUE,24);
    shape(whale,17,45,54,13,0xA6D2FF,7);shape(whale,45,52,16,10,0x3C6CD5,5);
    eye=shape(whale,20,28,5,7,0xFFFFFF,3);pupil=shape(eye,0,1,2,4,BG,2);
    shape(whale,19,40,7,2,BG,1);
    splash=shape(screen,64,87,4,7,0x8EDDF3,2);
    hero_primary=label_at(screen,132,94,89,25,&lv_font_montserrat_20,INK);
    hero_secondary=label_at(screen,132,123,89,25,&lv_font_montserrat_14,MUTED);
    body_panel=shape(screen,12,169,216,89,CARD,16);panel_border(body_panel);
    menu_focus=shape(body_panel,5,5,206,44,0x294657,11);hide(menu_focus,true);
    section=label_at(body_panel,12,9,192,20,&lv_font_montserrat_14,ACCENT);
    body=label_at(body_panel,12,35,192,47,&pet_font_cjk_16,INK);
    usage_value=label_at(body_panel,12,38,192,44,&lv_font_montserrat_20,INK);hide(usage_value,true);
    for(unsigned i=0;i<2;i++)menu_rows[i]=label_at(body_panel,12,63+(int)i*50,192,25,&pet_font_cjk_16,INK);
    for(unsigned i=0;i<4;i++){
        nav[i]=label_at(screen,12+(int)i*55,269,51,19,&lv_font_montserrat_14,MUTED);
        lv_obj_set_style_text_align(nav[i],LV_TEXT_ALIGN_CENTER,0);lv_label_set_text(nav[i],tabs[i]);
    }
    nav_mark=shape(screen,27,291,22,2,ACCENT,1);
    footer=label_at(screen,14,301,212,17,&lv_font_montserrat_14,MUTED);
    qr=lv_qrcode_create(screen);lv_qrcode_set_size(qr,176);lv_obj_set_pos(qr,32,82);
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
static void full_panel(const char *caption){
    lv_obj_set_pos(body_panel,12,80);lv_obj_set_height(body_panel,178);
    lv_obj_set_pos(body,12,40);lv_obj_set_height(body,126);lv_label_set_text(section,caption);
}
static void render_menu(void){
    char row[160];unsigned count=task_picker?view.current.task_count+1:advanced?5:(unsigned)ENTRY_COUNT;
    unsigned cursor=task_picker?picker_index:menu_selection;if(cursor>=count)cursor=0;
    full_panel("");hide(section,true);hide(menu_focus,false);
    lv_label_set_text(heading,task_picker?"Choose task":advanced?"Device settings":"Menu");
    lv_label_set_text_fmt(battery,"%u/%u",cursor+1,count);
    const char *hint=task_picker?"OK chooses, Hold OK goes back":advanced?advanced_hints[cursor]:entries[cursor].hint;
    lv_label_set_text(health,hint);
    unsigned start=(cursor/3)*3;
    lv_obj_set_pos(menu_focus,5,5+(int)(cursor-start)*50);
    lv_obj_t *rows[3]={body,menu_rows[0],menu_rows[1]};
    for(unsigned i=0;i<3;i++){
        lv_obj_t *o=rows[i];lv_obj_set_pos(o,12,13+(int)i*50);lv_obj_set_height(o,25);
        unsigned index=start+i;hide(o,index>=count);if(index>=count)continue;
        if(task_picker){if(index==view.current.task_count)snprintf(row,sizeof(row),"Back");else snprintf(row,sizeof(row),"%u. %s",index+1,display_text(view.current.tasks[index].title));}
        else snprintf(row,sizeof(row),"%s",advanced?advanced_titles[index]:entries[index].title);
        lv_label_set_text(o,row);lv_obj_set_style_text_color(o,lv_color_hex(index==cursor?ACCENT:INK),0);
    }
    lv_label_set_text(footer,"UP/DOWN select   OK open");
}
static const char *action_title(void){
    switch(action_view.phase){
        case PET_ACTION_PREPARING:return "Getting ready...";
        case PET_ACTION_READY:return "Open on computer?";
        case PET_ACTION_SENT:case PET_ACTION_ACCEPTED:return "Opening...";
        case PET_ACTION_SUCCEEDED:return "Opened on computer";
        case PET_ACTION_UNKNOWN:return "Result not confirmed";
        case PET_ACTION_CONFLICT:return "Task changed";
        case PET_ACTION_EXPIRED:return "Request expired";
        case PET_ACTION_FAILED:return "Could not open";
        default:return "Open on computer";
    }
}
static void render(const char *status,int soc){
    char text[640];hide(qr,true);hide(hero,true);hide(whale,true);hide(splash,true);
    hide(hero_primary,true);hide(hero_secondary,true);hide(menu_focus,true);hide(section,false);hide(body,false);
    hide(usage_value,true);
    for(unsigned i=0;i<2;i++)hide(menu_rows[i],true);
    bool modal=menu||settings_confirmation||action_dialog||info_page||pet_provision_active()||pet_runtime_setup_pending();
    for(unsigned i=0;i<4;i++){hide(nav[i],modal);lv_obj_set_style_text_color(nav[i],lv_color_hex(i==page_index?ACCENT:MUTED),0);}
    hide(nav_mark,modal);lv_obj_set_x(nav_mark,27+(int)page_index*55);
    lv_label_set_text(heading,pages[page_index]);
    if(soc<0)lv_label_set_text(battery,"--%");else lv_label_set_text_fmt(battery,"%d%%",soc);
    bool fresh=view.current.valid&&view.current.source_connected&&view.current.source_fresh;
    lv_obj_set_style_bg_color(status_dot,lv_color_hex(fresh?ACCENT:view.current.valid?AMBER:MUTED),0);
    lv_obj_set_style_text_color(health,lv_color_hex(MUTED),0);
    lv_obj_set_style_text_color(body,lv_color_hex(INK),0);
    const char *friendly=status;
    if(!strcmp(status,"Service synchronized"))friendly=fresh?(view.transport==PET_TRANSPORT_REMOTE?"Live via relay":"Live from your computer"):"Last received update";
    else if(!strcmp(status,"Not configured")||!strcmp(status,"Setup required")||!strcmp(status,"USB setup required"))friendly="Ready to connect";
    lv_label_set_text(health,friendly);full_panel("");
    if(pet_provision_active()&&!menu){
        lv_label_set_text(heading,"Phone setup");lv_label_set_text(health,phone_enabled?"Scan in the phone app":"OK enables Bluetooth");hide(body_panel,true);
        if(pet_provision_qr(qr_payload,sizeof(qr_payload))){
            if(strcmp(qr_payload,shown_qr)){if(lv_qrcode_update(qr,qr_payload,strlen(qr_payload))==LV_RESULT_OK)snprintf(shown_qr,sizeof(shown_qr),"%s",qr_payload);else lv_label_set_text(health,"QR unavailable: use USB");}
            if(shown_qr[0])hide(qr,false);
        }else lv_label_set_text(health,"Preparing secure setup...");
        lv_label_set_text(footer,"OK enable   Hold OK close");return;
    }
    hide(body_panel,false);memset(shown_qr,0,sizeof(shown_qr));memset(qr_payload,0,sizeof(qr_payload));
    if(pet_runtime_setup_pending()&&!menu){
        lv_label_set_text(heading,"USB connection");lv_label_set_text(section,"CONFIRM CONNECTION");
        lv_label_set_text(body,"Apply the settings sent\nfrom your computer?\n\nOnly continue if you\nstarted this setup.");
        lv_label_set_text(footer,"OK apply   Hold OK reject");return;
    }
    if(settings_confirmation){
        lv_label_set_text(heading,"Confirm change");lv_label_set_text(section,"YOUR CHOICE");
        const char *question=settings_confirmation==PET_SETTINGS_FORGET_WIFI?"Forget all Wi-Fi?":settings_confirmation==PET_SETTINGS_UNPAIR?"Unpair local service?":settings_confirmation==PET_SETTINGS_DISABLE_REMOTE?"Forget relay service?":"Reset this companion?";
        snprintf(text,sizeof(text),"%s\n\n%s Cancel\n%s Confirm & restart",question,confirm_yes?" ":">",confirm_yes?">":" ");
        lv_label_set_text(body,text);lv_label_set_text(footer,"UP/DOWN choose   OK apply");return;
    }
    if(action_dialog){
        bool no_request=!action_unavailable&&action_view.phase==PET_ACTION_IDLE&&!action_view.target_id[0];
        lv_label_set_text(heading,"Your computer");lv_label_set_text(section,no_request?"NO REQUEST":action_unavailable?"NOT AVAILABLE":action_title());
        const char *choice=action_view.can_confirm?"Open":action_view.can_query?"Check result":"Try again";
        if(no_request)snprintf(text,sizeof(text),"No host request yet.\n\nPick a task in Tasks,\nthen Open on computer.\n\nOK to go back");
        else if(action_unavailable)snprintf(text,sizeof(text),"Not available right now.\nCheck your local link\nor last request status.\n\nOK to go back");
        else snprintf(text,sizeof(text),"%s\n\n%s %s%s%s",display_text(action_view.title),action_choice?" ":">",action_view.can_confirm?"Cancel":"Close",alternative_available()?"\n":"",alternative_available()?action_choice?"> ":"  ":"");
        if(!action_unavailable&&alternative_available()){size_t n=strlen(text);snprintf(text+n,sizeof(text)-n,"%s",choice);}
        lv_label_set_text(body,text);lv_label_set_text(footer,!no_request&&!action_unavailable&&alternative_available()?"UP/DOWN choose   OK select":"OK close   Hold OK back");return;
    }
    if(info_page){
        lv_label_set_text(heading,"Your companion");lv_label_set_text(section,"AGENT PET");
        lv_label_set_text(body,"Firmware 0.2-dev\n\nUp to 3 Wi-Fi networks\nLocal + relay profiles\n\nOK returns to menu");
        lv_label_set_text(footer,"OK back   Hold OK menu");return;
    }
    if(menu){render_menu();return;}
    if(view.public_mode){
        lv_label_set_text(section,"PUBLIC MODE");lv_label_set_text(body,"Your private details\nare hidden.\n\nHold OK for privacy\nand connection settings.");
        lv_label_set_text(footer,"UP/DOWN page   Hold OK menu");return;
    }
    if(page_index==0){
        hide(hero,false);hide(whale,false);hide(splash,false);hide(hero_primary,false);hide(hero_secondary,false);
        lv_obj_set_pos(hero_primary,132,94);lv_obj_set_size(hero_primary,89,25);
        lv_obj_set_pos(body_panel,12,169);lv_obj_set_height(body_panel,89);lv_obj_set_pos(body,12,35);lv_obj_set_height(body,47);
        unsigned running=0,waiting=0;int best=-1,rank=-1;
        for(unsigned i=0;i<view.current.task_count;i++){pet_task_t *task=&view.current.tasks[i];running+=task->running;waiting+=task->waiting;int r=task->waiting?3:task->running?2:task->state==PET_FAILED?1:0;if(r>rank){best=(int)i;rank=r;}}
        if(!view.current.valid){lv_label_set_text(hero_primary,"Hi there");lv_label_set_text(hero_secondary,"Let's pair");lv_label_set_text(section,"GET STARTED");lv_label_set_text(body,"Connect your phone\nor your computer.");}
        else{if(running)lv_label_set_text_fmt(hero_primary,"%u active",running);else lv_label_set_text(hero_primary,"All quiet");
            if(waiting)lv_label_set_text_fmt(hero_secondary,"%u need you",waiting);else lv_label_set_text(hero_secondary,fresh?"Up to date":"Saved update");
            lv_label_set_text(section,waiting?"NEEDS YOUR ATTENTION":best>=0?"CURRENT TASK":"ALL CAUGHT UP");lv_label_set_text(body,best>=0?display_text(view.current.tasks[best].title):"New tasks will appear here.");}
        lv_label_set_text(footer,view.current.task_count?"OK view task   Hold OK menu":"OK set up   Hold OK menu");return;
    }
    if(page_index==1){
        pet_task_t *task=selected_task();
        if(!task){lv_label_set_text(section,"YOUR TASKS");lv_label_set_text(body,"No tasks received yet.\n\nConnect your computer\nto see its live updates.");}
        else{lv_label_set_text_fmt(section,"TASK %u OF %u",selected+1,view.current.task_count);
            snprintf(text,sizeof(text),"%s\n\n%s%s\n%s",display_text(task->title),task->running?"Running":pet_state_name(task->state),task->waiting?" / needs you":"",task->goal_completed?"Completion reported":"Outcome not reported");lv_label_set_text(body,text);}
        lv_label_set_text(footer,view.current.task_count>1?"OK next task   Hold OK menu":view.current.task_count?"OK open   Hold OK menu":"OK set up   Hold OK menu");return;
    }
    if(page_index==2){
        lv_label_set_text(section,details?"USAGE SOURCE":"SESSION TOKENS");
        if(details){lv_obj_set_pos(body,12,34);lv_obj_set_height(body,132);snprintf(text,sizeof(text),"%s\n\nLoaded sessions only.\nCost / quota not reported.",view.current.usage_known?display_text(view.current.provenance):"No verified usage source");lv_label_set_text(body,text);}
        else{hide(usage_value,false);lv_label_set_text(usage_value,view.current.usage_known?view.current.tokens:"--");lv_obj_set_pos(body,12,94);lv_obj_set_height(body,62);lv_label_set_text(body,view.current.usage_known?"Loaded sessions only.\nCost not reported.":"No verified usage yet.\nConnect your computer.");}
        lv_label_set_text(footer,details?"OK summary   Hold OK menu":"OK source   Hold OK menu");return;
    }
    lv_label_set_text(section,"YOUR INBOX");
    if(!view.current.inbox_count)lv_label_set_text(body,"You're all caught up.\n\nNew summaries will\nappear here.");
    else{if(selected>=view.current.inbox_count)selected=0;lv_label_set_text_fmt(section,"UPDATE %u OF %u",selected+1,view.current.inbox_count);lv_label_set_text(body,display_text(view.current.inbox[selected]));}
    lv_label_set_text(footer,view.current.inbox_count>1?"OK next   Hold OK menu":"UP/DOWN page   Hold OK menu");
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
            if(!menu&&!details&&page_index==0){lv_obj_set_y(whale,95+(tick%12<6?0:1));lv_obj_set_y(splash,87+(tick%12<6?0:1));bool blink=tick%36==0;lv_obj_set_height(eye,blink?2:7);hide(pupil,blink);}
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
