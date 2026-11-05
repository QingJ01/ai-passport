#include "agent_pet_config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static const char setup[]="{\"v\":1,\"type\":\"setup\",\"ssid\":\"home\",\"pass" "word\":\"network-key\",\"endpoint\":\"wss://bridge.example/v1/device\",\"token\":\"fixture-" "0123456789" "0123456789" "0123456789" "0123456789\",\"time\":1800000000,\"ca_pem\":\"-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----\\n\"}";
int main(void){
    pet_config_t c={.version=PET_CONFIG_VERSION};pet_candidate_t p;
    assert(pet_config_parse_setup(setup,strlen(setup),&p));assert(p.target==PET_TRANSPORT_LOCAL&&p.has_network&&p.has_profile);assert(strchr(p.profile.ca,'\n'));
    assert(pet_config_network_slot(&c,&p)==0);assert(pet_config_commit(&c,&p));assert(pet_config_valid(&c));
    assert(c.network_count==1&&!strcmp(c.transport[0].device_id,"passport-1"));
    strcpy(p.network.ssid,"office");assert(pet_config_network_slot(&c,&p)==1);assert(pet_config_commit(&c,&p));
    strcpy(p.network.ssid,"hotspot");assert(pet_config_commit(&c,&p));assert(c.network_count==3);
    pet_config_t before=c;strcpy(p.network.ssid,"fourth");assert(pet_config_network_slot(&c,&p)==-1);assert(!pet_config_commit(&c,&p));assert(!memcmp(&c,&before,sizeof(c)));
    p.replace_slot=1;p.target=PET_TRANSPORT_REMOTE;strcpy(p.profile.endpoint,"wss://relay.example/v1/relay");strcpy(p.profile.device_id,"remote-device");strcpy(p.profile.time_issuer,"relay-issuer");assert(pet_config_commit(&c,&p));assert(c.network_count==3&&c.mode==PET_TRANSPORT_REMOTE&&c.active_network==1);
    assert(!strcmp(c.networks[0].ssid,"home")&&!strcmp(c.networks[1].ssid,"fourth")&&!strcmp(c.networks[2].ssid,"hotspot"));assert(!strcmp(c.transport[0].endpoint,"wss://bridge.example/v1/device"));assert(!strcmp(c.transport[1].device_id,"remote-device"));
    p.replace_slot=3;assert(!pet_config_commit(&c,&p));p.replace_slot=-2;assert(!pet_config_commit(&c,&p));p.replace_slot=-1;strcpy(p.network.ssid,"home");assert(pet_config_network_slot(&c,&p)==0);
    p.has_network=false;assert(pet_config_network_slot(&c,&p)==1);
    const char *bad[]={"{\"v\":1,\"type\":\"setup\",\"transport\":\"other\"}","{\"v\":1,\"type\":\"setup\",\"ssid\":\"bad\\u0000name\",\"pass" "word\":\"key\"}","{\"v\":1,\"type\":\"setup\",\"replace_slot\":3}","{\"v\":1,\"type\":\"setup\",\"replace_slot\":null}","{\"v\":1,\"type\":\"setup\",\"pass" "word\":\"key\"}"};
    for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++)assert(!pet_config_parse_setup(bad[i],strlen(bad[i]),&p));
    pet_transport_config_t profile=c.transport[0];strcpy(profile.endpoint,"http://bridge.example");assert(!pet_config_profile_valid(&profile));strcpy(profile.endpoint,"wss://bridge.example/?token=x");assert(!pet_config_profile_valid(&profile));strcpy(profile.endpoint,"wss://user@bridge.example/");assert(!pet_config_profile_valid(&profile));
    pet_json_t j;bool flag;const char *quoted="{\"flag\":\"true\"}";assert(pet_json_parse(&j,quoted,strlen(quoted)));assert(!pet_json_bool(&j,pet_json_field(&j,0,"flag"),&flag));
    FILE *wire_file=fopen("tests/fixtures/agent-pet-setup.json","rb");assert(wire_file);
    static char wire[8192];size_t wire_len=fread(wire,1,sizeof(wire)-1,wire_file);fclose(wire_file);wire[wire_len]=0;
    pet_config_t fresh={.version=PET_CONFIG_VERSION};
    assert(pet_config_parse_setup(wire,wire_len,&p));
    assert(p.has_profile&&p.has_network&&p.target==PET_TRANSPORT_LOCAL&&p.replace_slot==-1);
    assert(!strcmp(p.network.ssid,"AgentPetFixture")&&!strcmp(p.network.key,"fixture-network-key"));
    assert(!strcmp(p.profile.endpoint,"wss://192.0.2.10:7443/v1/device")&&!strcmp(p.profile.server,"agentpet.local"));
    assert(!strcmp(p.profile.device_id,"passport-fixture")&&p.profile.time_url[0]&&p.profile.time_key[0]);
    assert(strchr(p.profile.ca,'\n')&&!strncmp(p.profile.ca,"-----BEGIN CERTIFICATE-----",5));
    assert(p.utc_seconds==1762300000);
    assert(pet_config_network_slot(&fresh,&p)==0&&pet_config_commit(&fresh,&p));
    assert(pet_config_valid(&fresh)&&fresh.mode==PET_TRANSPORT_LOCAL&&fresh.network_count==1);
    printf("Python-built setup payload accepted by the firmware parser (%zu bytes)\n",wire_len);
    assert(sizeof(pet_config_t)+sizeof(pet_candidate_t)<12000);
    printf("Agent Pet bounded profiles/config tests passed (resident config+candidate %zu bytes)\n",sizeof(pet_config_t)+sizeof(pet_candidate_t));return 0;
}
