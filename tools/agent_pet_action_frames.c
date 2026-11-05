/* Emit the exact action frames the firmware builds, for cross-language tests. */
#include "agent_pet_action.h"
#include <stdio.h>
#include <string.h>

int main(void) {
    const char *boot = "00112233445566778899aabbccddeeff";
    const char *action_id = "ffeeddccbbaa99887766554433221100";
    const char *epoch = "fixture-epoch";
    const char *stream = "fixture-stream";
    const char *target = "fixture-task";
    const char *offer =
        "{\"v\":1,\"type\":\"action.offer\",\"stream_id\":\"fixture-stream\","
        "\"view_epoch\":\"fixture-epoch\",\"revision\":3,\"payload\":{"
        "\"token\":\"fixturetoken0000000000000000000000000000000000\","
        "\"type\":\"open_on_host\",\"target_id\":\"fixture-task\","
        "\"target_revision\":1762300000123,"
        "\"expires_at\":\"2030-01-01T00:00:00.000Z\"}}";
    pet_action_t action;
    char frame[1024];
    int n;

    pet_action_init(&action, boot);
    if (!pet_action_begin(&action, target, 1762300000123ULL, action_id, 1000)) return 1;
    n = pet_action_compose(&action, PET_ACTION_PREPARE_COMMAND, epoch, frame, sizeof(frame));
    if (n <= 0) return 1;
    printf("%s\n", frame);

    if (!pet_action_ingest(&action, offer, strlen(offer), epoch, stream, 1500, 0)) return 1;
    if (!pet_action_confirm(&action, 1762300000123ULL, 1600)) return 1;
    n = pet_action_compose(&action, PET_ACTION_EXECUTE_COMMAND, epoch, frame, sizeof(frame));
    if (n <= 0) return 1;
    printf("%s\n", frame);

    n = pet_action_compose(&action, PET_ACTION_QUERY_COMMAND, epoch, frame, sizeof(frame));
    if (n <= 0) return 1;
    printf("%s\n", frame);
    return 0;
}
