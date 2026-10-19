# Balloon Stack

**Reverse Jenga with balloons, and a small, fully observable probabilistic AI.**

**Play it:** https://lewisca.github.io/Balloon-Stack/

![Balloon Stack screenshot](docs/screenshot.png)
<!-- Screenshot placeholder: save a capture of the game with the AI inspector open as docs/screenshot.png -->

Drag 11 balloons off the floor and stack them into a corner. If any balloon rolls out past the lip, the stack falls. Every balloon has hidden **grip** and **bounce** values, so the same placement can hold with one balloon and fail with another. You can play solo or take turns against an AI forecaster that has to deal with the same uncertainty you do.

The whole game is one self-contained `index.html`. Double-click it to play; there's nothing to install.

## Why it's a probabilistic AI demo

The game is a small, end-to-end example of making decisions under uncertainty, with each step out in the open:

| Idea | How it shows up in the game |
| --- | --- |
| **Hidden variables** | Each balloon's grip and bounce drive the physics (friction, static friction, restitution) but are never shown to the player or the AI. |
| **Bayesian belief updates** | The AI keeps a Gaussian belief (mean and variance) for each balloon's grip and bounce. A *squeeze* gives a noisy reading (σ = 0.15), and a Kalman-style update shifts the mean toward that reading and shrinks the variance. The Kalman gain is reported, so you can see how much each reading counted. |
| **Monte Carlo forecasting with physics rollouts** | To score a placement, the forecaster rebuilds the current stack in a fresh [Matter.js](https://brm.io/matter-js/) world, draws every balloon's hidden values from its beliefs, drops the new balloon, and simulates. The share of rollouts in which nothing spills is its estimate of P(hold). |
| **An AI opponent that picks by expected success** | On its turn, the AI squeezes whichever balloon it's least sure about, shortlists the three balloons it believes are grippiest, runs 8 rollouts for every spot, refines the top three to 32 rollouts, and plays the one most likely to hold. |
| **Calibration scoring** | Every forecast is graded against what actually happened. The inspector shows a reliability table (predicted vs. actual by bucket) and the running **Brier score**. A headless check measures calibration over many simulated games and fails the build if it drifts. |
| **Decision tracing for observability** | Each game is an OpenTelemetry session, and each move is its own trace: `move > squeeze / forecast / physics.settle`. Spans record priors, readings, posteriors, candidate odds, the AI's decision, and the outcome. The trace downloads as OTLP/JSON and loads into Jaeger or any OpenTelemetry backend. |

The player's view has no numbers. Turn on the **AI inspector** to see per-spot odds, belief bars with uncertainty bands, the calibration table, the Brier score, and the decision trace.

## How to play

1. Drag a balloon off the floor and let go over the corner. It settles where you drop it.
2. If any balloon rolls out past the lip, the stack falls. Get all 11 up to win.
3. You get one **squeeze** per turn. It tells you roughly how grippy and bouncy a balloon is. Grippy, soft balloons stack best.
4. Choose **Solo** to stack all 11 yourself, or **Versus the AI** to take turns. In versus mode, whoever spills a balloon loses and whoever places the last one wins.

## Running the build and checks

You need Node 18 or later.

```bash
npm install
npm run build   # assemble index.html from src/
npm run check   # headless calibration check; fails if Brier > 0.08
npm run trace   # play a seeded game headlessly and write docs/sample-trace.json
npm run export -- <trace.json>   # send a trace to an OTLP collector (default localhost:4318)
```

`npm run check` plays seeded games in Node, forecasts each move with 16 rollouts, plays it out for real, and reports the result:

```
moves 74 brier 0.025
bucket 0-20%: n=5 predicted 3% actual 20%
bucket 20-40%: n=2 predicted 31% actual 50%
bucket 60-80%: n=1 predicted 75% actual 100%
bucket 80-100%: n=66 predicted 99% actual 100%
PASS: Brier 0.025 <= 0.08
```

Every push to `main` runs the build and the check in GitHub Actions. The game is published to GitHub Pages only if both pass.

### Layout

```
src/head.html    styles
src/body.html    markup
src/sim.js       physics world, belief sampling, Monte Carlo rollouts (shared with Node)
src/game.js      game loop, AI, tracing, input, rendering
build.js         concatenates src/ into index.html
index.html       the built single-file game
headless/        calibration check, sample-trace generator, OTLP exporter
docs/            sample trace (and screenshot)
```

## Traces: one session per game, one trace per move

Every game is a **session**. Each balloon placement is its own **trace**, rooted at a `move` span:

```
session 91297a41…  (session.id on every span)
├── trace: game                 mode, result, Brier score, true hidden values
├── trace: move 1
│   ├── squeeze                 prior → noisy reading → Kalman gain → posterior
│   ├── forecast                every candidate spot with its rollouts and P(hold)
│   └── physics.settle          the real outcome: held, or which balloons spilled
├── trace: move 2
│   └── …
```

**Download trace** in the inspector saves the current game as strict [OTLP/JSON](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding), the format OpenTelemetry collectors accept at `/v1/traces`.

### A trace excerpt

From [`docs/sample-trace.json`](docs/sample-trace.json), a solo game the forecaster played headlessly and won with all 11 balloons stacked. On move 3 it squeezed balloon #5. The reading pulled the bounce estimate from 0.5 down to 0.381 and cut both variances from 0.063 to 0.017. Shown here with attributes flattened for reading; the file uses OTLP's `{key, value}` encoding.

```json
{
  "name": "squeeze",
  "traceId": "6221557ee486a5994e49caafaba4fff4",
  "parentSpanId": "66e3b789af583deb",
  "attributes": {
    "session.id": "91297a415a7c277f06c5150acb132185",
    "balloon.id": 5,
    "prior.grip_mean": 0.5,       "prior.bounce_mean": 0.5,     "prior.grip_var": 0.063,
    "reading.grip": 0.551,        "reading.bounce": 0.339,      "reading.noise_sd": 0.15,
    "kalman_gain.grip": 0.735,
    "posterior.grip_mean": 0.537, "posterior.bounce_mean": 0.381, "posterior.grip_var": 0.017
  }
}
```

It then compared 21 candidate spots across three balloons (240 rollouts in total), placed #5 in spot 2 with a 100% forecast, and the stack held:

```json
{
  "name": "move",
  "traceId": "6221557ee486a5994e49caafaba4fff4",
  "spanId": "66e3b789af583deb",
  "attributes": {
    "session.id": "91297a415a7c277f06c5150acb132185",
    "move.number": 3, "move.actor": "ai", "stack.size": 2,
    "balloon.id": 5, "spot": 2,
    "prediction.p_hold": 1, "prediction.rollouts": 32,
    "outcome.held": true, "brier.contribution": 0
  },
  "events": [{ "name": "ai.decision", "attributes": {
    "policy": "max p_hold over top-3 balloons by believed grip",
    "shortlist": [5, 6, 7], "chosen_balloon": 5, "chosen_spot": 2, "p_hold": 1 } }]
}
```

### Viewing traces in a trace viewer

Any OpenTelemetry backend works. To run one locally with [Jaeger](https://www.jaegertracing.io/download/):

1. Start Jaeger v2. Either use Docker, `docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest`, or download the binary for your OS and run `jaeger`. It accepts OTLP over HTTP on port 4318.
2. Play a game, open the inspector, and click **Download trace**.
3. Send it: `npm run export -- path/to/balloon-stack-trace-….json`. You can also try it with the sample: `npm run export -- docs/sample-trace.json`.
4. Open http://localhost:16686 and pick service **balloon-stack**. Each move is a trace. To see one game, search by tag `session.id=<id>`.

To send traces somewhere else, pass the endpoint as a second argument, or set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Viewers with a sessions view, such as [Arize Phoenix](https://phoenix.arize.com/), group the traces by `session.id`.

## Lessons learned: a calibration bug found through the inspector

In an early build, the inspector's calibration table looked wrong. The forecaster rated safe moves near 0%, and those moves then held in the real game. The forecasts weren't just noisy; they were confidently pessimistic, and the Brier score was **0.178**.

The cause was in how each simulation rebuilt the stack. The real stack has settled: its balloons have come to rest against each other, and static friction holds them there. Each rollout, though, rebuilt the stack from saved positions in a brand-new physics world, with full gravity applied on the first step and none of that settled contact. The copies sagged and collapsed **on their own**, before the new balloon was even added. The forecaster was measuring how a freshly dropped pile behaves, not the stack in front of it.

The fix eases gravity in over the first 90 steps, with extra air damping, so each copy settles into contact before the candidate balloon is dropped. After that change the Brier score went from **0.178 to 0.025** in testing. `npm run check` now guards that number, so a regression fails CI.

What I took from it:

- **Calibration is a stronger test than accuracy.** A forecaster can rank moves in a reasonable order and still be badly miscalibrated. A reliability table showed the problem right away.
- **Make the model's reasoning observable.** Without per-move spans showing predicted odds next to outcomes, this would have looked like "the AI is a bit timid."
- **A simulation is a model too.** Monte Carlo is only as good as the simulator's starting state. Rebuilding state is where hidden assumptions creep in.

## License

[MIT](LICENSE)
