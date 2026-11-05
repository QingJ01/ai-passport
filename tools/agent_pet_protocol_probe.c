/* Host-side consumer for testing actual bridge frames against firmware logic. */
#include "agent_pet_model.h"
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv)
{
    pet_model_t model;
    pet_model_init(&model, argc > 1 ? argv[1] : "contract-test");
    char line[PET_FRAME_MAX + 3];
    unsigned frames = 0;
    while (fgets(line, sizeof(line), stdin)) {
        size_t length = strlen(line);
        if (length && line[length - 1] == '\n') line[--length] = 0;
        if (length && line[length - 1] == '\r') line[--length] = 0;
        if (!length) continue;
        if (length > PET_FRAME_MAX) {
            fprintf(stderr, "Frame %u exceeds firmware bound\n", frames + 1);
            return 2;
        }
        pet_result_t result = pet_model_ingest(&model, line, length, 1000 + frames);
        if (result != PET_APPLIED) {
            fprintf(stderr, "Frame %u did not apply: %d\n", frames + 1, result);
            return 3;
        }
        frames++;
    }
    if (ferror(stdin) || !model.current.valid || model.synchronizing) return 4;
    unsigned running = 0, waiting = 0;
    for (size_t i = 0; i < model.current.task_count; i++) {
        running += model.current.tasks[i].running;
        waiting += model.current.tasks[i].waiting;
    }
    printf("{\"frames\":%u,\"tasks\":%u,\"running\":%u,\"waiting\":%u,"
           "\"inbox\":%u,\"revision\":%u,\"usage_known\":%s,\"tokens\":\"%s\"}\n",
           frames, model.current.task_count, running, waiting,
           model.current.inbox_count, model.current.revision,
           model.current.usage_known ? "true" : "false", model.current.tokens);
    return 0;
}
