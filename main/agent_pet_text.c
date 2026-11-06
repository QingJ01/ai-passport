#include "agent_pet_text.h"
#include <stdio.h>
#include <string.h>

typedef struct { const char *source, *text; } pet_text_pair_t;
/* Currency glyphs the bridge may send in cost strings; listed so the UI subset
 * fonts include them: ￥ $ */

/* Runtime status lines (English, also used in logs) and their screen copy.
 * tests/test_agent_pet_text_coverage.py fails when a runtime literal is missing. */
static const pet_text_pair_t statuses[]={
    {"USB setup required","等待连接"},
    {"Not configured","等待连接"},
    {"Setup required","等待连接"},
    {"USB setup: 120 seconds","USB 已开放"},
    {"Setup received: press OK","收到设置，按 OK 确认"},
    {"Authenticated; waiting for source","已连接，等待数据"},
    {"Authentication timed out","认证超时，正在重试"},
    {"Wi-Fi ready; connecting service","Wi-Fi 已连接，正在连服务"},
    {"Wi-Fi disconnected; retrying","Wi-Fi 已断开，正在重试"},
    {"Service disconnected; retrying","服务已断开，正在重试"},
    {"Service data stale; reconnecting","数据过期，正在重连"},
    {"Configure selected service first","请先配置所选服务"},
    {"Host action unavailable; check request","暂时无法在电脑上打开"},
    {"Trusted service/network required","需要可信的服务和网络"},
    {"Candidate failed; settings retained","新设置未生效，原设置保留"},
    {"Settings verified and saved","新设置已验证并保存"},
    {"Setup cancelled; settings retained","已取消，原设置保留"},
    {"Settings unavailable during setup","设置中，暂时不能修改"},
    {"Settings operation failed; retry","操作失败，请重试"},
    {"Unpaired; root cleanup failed, retry","已解除配对，清理未完成"},
    {"Clock unknown: USB time repair","时间未知，请用 USB 校准"},
    {"Recovering signed service time","正在校准时间"},
    {"Signed time failed: USB repair","校时失败，请用 USB 修复"},
    {"Network unavailable; USB works","网络不可用，USB 仍可用"},
    {"Phone setup unavailable; try USB","手机配对不可用，请用 USB"},
    {"Privacy setting save failed","隐私设置保存失败"},
    {"Theme setting save failed","主题保存失败"},
    {"Storage unavailable; not erased","存储不可用，数据未清除"},
    {"TLS/service start failed","无法建立安全连接"},
    {"Testing candidate network/service","正在测试新网络"},
    {"USB unavailable","USB 不可用"},
    {"Worker allocation failed","内存不足，请重启"},
    {"Runtime unavailable","系统未就绪"},
};
#define COUNT(a) (sizeof(a)/sizeof((a)[0]))

bool pet_text_status_known(const char *s){
    if(!s)return false;
    if(!strcmp(s,"Service synchronized"))return true;
    for(size_t i=0;i<COUNT(statuses);i++)if(!strcmp(s,statuses[i].source))return true;
    return false;
}

const char *pet_text_status(const char *s,bool fresh,bool remote){
    if(!s)return "状态未知";
    if(!strcmp(s,"Service synchronized"))return fresh?(remote?"中继实时同步":"电脑实时同步"):"显示上次收到的数据";
    for(size_t i=0;i<COUNT(statuses);i++)if(!strcmp(s,statuses[i].source))return statuses[i].text;
    return "状态未知";
}

const char *pet_text_task_state(const pet_task_t *t){
    if(!t)return "";
    if(t->waiting)return t->running?"进行中，等你回复":"等你回复";
    if(t->running)return "进行中";
    switch(t->state){
        case PET_QUEUED:return "排队中";
        case PET_RUNNING:return "进行中";
        case PET_WAITING:return "等你回复";
        case PET_COMPLETED:return "已完成";
        case PET_FAILED:return "失败";
        case PET_CANCELLED:return "已取消";
        default:return "空闲";
    }
}

const char *pet_text_action_title(pet_action_phase_t p){
    switch(p){
        case PET_ACTION_PREPARING:return "准备中";
        case PET_ACTION_READY:return "在电脑上打开？";
        case PET_ACTION_SENT:case PET_ACTION_ACCEPTED:return "正在打开";
        case PET_ACTION_SUCCEEDED:return "已在电脑上打开";
        case PET_ACTION_UNKNOWN:return "结果未确认";
        case PET_ACTION_CONFLICT:return "任务已变化";
        case PET_ACTION_EXPIRED:return "请求已过期";
        case PET_ACTION_FAILED:return "打开失败";
        default:return "在电脑上打开";
    }
}

const char *pet_text_provenance(const char *p){
    if(!p||!p[0]||!strcmp(p,"unavailable"))return "暂无来源";
    if(!strcmp(p,"host-reduced-records"))return "电脑端汇总";
    if(!strcmp(p,"hidden"))return "已隐藏";
    if(!strcmp(p,"magpie-today"))return "Magpie 今日统计";
    return NULL;
}

const char *pet_text_inbox(const char *title){
    if(title&&!strcmp(title,"Input requested"))return "有任务在等你回复";
    return title?title:"";
}

void pet_text_group_digits(const char *s,char *out,size_t cap){
    if(!out||!cap)return;
    out[0]=0;if(!s)return;
    size_t n=strlen(s);bool digits=n>0;
    for(size_t i=0;i<n;i++)if(s[i]<'0'||s[i]>'9'){digits=false;break;}
    if(!digits){snprintf(out,cap,"%s",s);return;}
    size_t o=0;
    for(size_t i=0;i<n&&o+1<cap;i++){
        if(i&&(n-i)%3==0){if(o+2>=cap)break;out[o++]=',';}
        out[o++]=s[i];
    }
    out[o]=0;
}

void pet_text_compact_count(const char *s,char *out,size_t cap){
    if(!out||!cap)return;
    size_t n=s?strlen(s):0;
    if(n<=3){pet_text_group_digits(s,out,cap);return;}
    for(size_t i=0;i<n;i++)if(s[i]<'0'||s[i]>'9'){snprintf(out,cap,"%s",s);return;}
    /* K from 1e3, M from 1e6, B from 1e9; one decimal, truncated not rounded. */
    size_t whole=n>9?n-9:n>6?n-6:n-3;const char *unit=n>9?"B":n>6?"M":"K";
    if(whole>3&&n>9){if(whole>12){snprintf(out,cap,"%s",s);return;}}
    char head[16];memcpy(head,s,whole);head[whole]=0;
    if(whole<3&&s[whole]!='0')snprintf(out,cap,"%s.%c%s",head,s[whole],unit);
    else snprintf(out,cap,"%s%s",head,unit);
}

void pet_text_task_metrics(const pet_task_t *t,char *out,size_t cap){
    if(!out||!cap)return;
    out[0]=0;if(!t)return;
    size_t used=0;char count[24];
    if(t->tokens[0]){pet_text_compact_count(t->tokens,count,sizeof(count));used+=(size_t)snprintf(out+used,cap-used,"%s Token",count);}
    if(t->rate[0]&&used<cap)used+=(size_t)snprintf(out+used,cap-used,"%s%s t/s",used?"・":"",t->rate);
    if(t->cost[0]&&used<cap)snprintf(out+used,cap-used,"%s费用 %s%s",used?"\n":"",t->cost_estimate?"约":"",t->cost);
}
