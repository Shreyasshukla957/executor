/** Wait until a deployed stage answers only from its real API Worker. */
import { Console, Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";

const Health = Schema.Struct({ status: Schema.Literal("ok") });

/**
 * Consecutive real answers, one second apart, that end the rollout wait.
 * In a measured fresh deployment, about a third of requests reached the
 * placeholder for 20 seconds after Alchemy finished, interleaved with real answers.
 */
const requiredAnswers = 20;

/**
 * Alchemy first uploads a placeholder API Worker, which answers every path with
 * HTTP 200 plain text, and then uploads the real one. Cloudflare rolls the new
 * version out gradually, so for a while after the upload requests reach either
 * version. A session object started on the placeholder is reset when the real code
 * arrives, which ends its streams. Only an unbroken run of real `/health` answers
 * shows that the rollout has finished.
 */
export const awaitStageRollout = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const answer = client.get(`${origin}/health`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Health)),
      Effect.match({ onSuccess: () => true, onFailure: () => false }),
    );
    let consecutive = 0;
    let other = 0;
    while (consecutive < requiredAnswers) {
      if (yield* answer) consecutive++;
      else {
        consecutive = 0;
        other++;
      }
      yield* Effect.sleep("1 second");
    }
    yield* Console.log(
      `Rollout complete: ${requiredAnswers} consecutive API answers after ${other} other responses.`,
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "3 minutes",
      orElse: () =>
        Effect.fail(
          new TestStageFailed({ message: `${origin} did not finish rolling out its API Worker.` }),
        ),
    }),
  );
