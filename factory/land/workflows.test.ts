import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Schema } from "effect";

import { CI_CHECKS } from "../contract.ts";
import { APP_LOGIN, AUTHOR_LOGIN, OWNER_LOGIN } from "../install/logins.ts";
import {
  inputsOf,
  requestOfVariables,
  REVIEW_RESULT_FILE,
  REVIEW_VARIABLES,
  REVIEW_WORKFLOW,
} from "./review/review-report.ts";
import type { ReviewRequest } from "./review/review-report.ts";

/** A request whose every field differs from the others, so an input carried into another field's variable shows. */
const REQUEST: ReviewRequest = {
  pr: 7,
  head: "a".repeat(40),
  base: "b".repeat(40),
  patch: "p1",
  round: 2,
  model: "sonnet",
  effort: "medium",
  security: true,
};

const Dispatch = Schema.Struct({ workflow_dispatch: Schema.Struct({ inputs: Schema.JsonObject }) });

const Step = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.JsonObject),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const Workflow = Schema.Struct({
  name: Schema.String,
  on: Schema.JsonObject,
  "run-name": Schema.optionalKey(Schema.String),
  permissions: Schema.Record(Schema.String, Schema.String),
  concurrency: Schema.optionalKey(Schema.Struct({ group: Schema.String, "cancel-in-progress": Schema.Boolean })),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optionalKey(Schema.String),
      "timeout-minutes": Schema.optionalKey(Schema.Int),
      env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.Array(Step),
    }),
  ),
});

const WorkflowRun = Schema.Struct({ workflow_run: Schema.Struct({ workflows: Schema.Array(Schema.String) }) });

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");

const sourceOf = (file: string): Promise<string> => Bun.file(join(WORKFLOWS, file)).text();

const workflowOf = async (file: string): Promise<typeof Workflow.Type> =>
  Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(await sourceOf(file)));

const stepNamed = (steps: (typeof Workflow.Type.jobs)[string]["steps"], name: string): typeof Step.Type => {
  const step = steps.find((found) => found.name === name);

  if (step === undefined) {
    throw new Error(`no step named ${name}`);
  }

  return step;
};

describe("the review job's workflow", () => {
  test("only a dispatch starts it, titled with the PR's number alone, and no concurrency group ever cancels a run", async () => {
    const workflow = await workflowOf(REVIEW_WORKFLOW);

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow["run-name"]).toBe("${{ inputs.pr }}");
    expect(workflow.concurrency).toBeUndefined();
  });

  test("it reads the contents and the pull requests, and holds no secret but the OAuth token", async () => {
    const workflow = await workflowOf(REVIEW_WORKFLOW);

    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(new Set((await sourceOf(REVIEW_WORKFLOW)).match(/secrets\.\w+/gu))).toEqual(
      new Set(["secrets.CLAUDE_CODE_OAUTH_TOKEN"]),
    );
  });

  test("every checkout leaves no credential behind, and the Review step gets no GitHub token", async () => {
    const { steps, env } = (await workflowOf(REVIEW_WORKFLOW)).jobs["review"] ?? { steps: [] };
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@") === true);

    expect(checkouts).toHaveLength(2);

    for (const checkout of checkouts) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }

    expect(stepNamed(steps, "Review").env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    });
    expect(Object.keys(env ?? {}).filter((name) => name.includes("TOKEN"))).toEqual([]);
  });

  test("only the thread step, at every round, gets the job's token, before the Review step", async () => {
    const { steps } = (await workflowOf(REVIEW_WORKFLOW)).jobs["review"] ?? { steps: [] };
    const tokened = steps.filter((step) => step.env?.["GH_TOKEN"] !== undefined);

    expect(tokened.map((step) => step.name)).toEqual(["Read the earlier review threads"]);
    expect(tokened[0]).toMatchObject({
      run: "bun factory/bin/review-threads.ts",
      env: { GH_TOKEN: "${{ github.token }}" },
    });
    expect(tokened[0]?.if).toBeUndefined();
    expect(steps.indexOf(stepNamed(steps, "Read the earlier review threads"))).toBeLessThan(
      steps.indexOf(stepNamed(steps, "Review")),
    );
  });

  test("the security flag is a required input that reaches the runner through env, and the job's timeout leaves room for two passes", async () => {
    const workflow = await workflowOf(REVIEW_WORKFLOW);
    const { steps, env } = workflow.jobs["review"] ?? { steps: [] };

    expect(workflow.on).toMatchObject({
      workflow_dispatch: {
        inputs: {
          security: {
            description: "Whether a security pass runs after the Code review, true or false",
            required: true,
          },
        },
      },
    });
    expect(env?.["REVIEW_SECURITY"]).toBe("${{ inputs.security }}");
    expect(workflow.jobs["review"]?.["timeout-minutes"]).toBe(50);
    expect(stepNamed(steps, "Write a failed result when the runner wrote none").run).toContain(
      'security: ($security == "true")',
    );
  });

  test("the result is uploaded whatever happened, under the name the Merge bot reads", async () => {
    const { steps } = (await workflowOf(REVIEW_WORKFLOW)).jobs["review"] ?? { steps: [] };

    expect(stepNamed(steps, "Upload the result")).toMatchObject({
      if: "always()",
      with: { name: "review-${{ inputs.pr }}-${{ inputs.round }}", path: REVIEW_RESULT_FILE, overwrite: true },
    });
  });

  test("the request the Merge bot dispatches reaches the runner whole: each input, the job's variable that carries it, the runner's read", async () => {
    const workflow = await workflowOf(REVIEW_WORKFLOW);
    const { env } = workflow.jobs["review"] ?? { steps: [] };
    const inputs = inputsOf(REQUEST);

    expect(Object.keys(Schema.decodeUnknownSync(Dispatch)(workflow.on).workflow_dispatch.inputs).toSorted()).toEqual(
      Object.keys(inputs).toSorted(),
    );

    // The job's env as the runner sees it: each `${{ inputs.<name> }}` holds the dispatched input of that name.
    const variables = Object.fromEntries(
      Object.entries(env ?? {}).map(([name, value]) => [
        name,
        value.replace(/^\$\{\{ inputs\.(\w+) \}\}$/u, (_, input: string) => inputs[input] ?? value),
      ]),
    );

    expect(requestOfVariables(variables)).toEqual(REQUEST);
  });

  test("the failed result the job writes when the runner wrote none reads every variable of the request, into the file it uploads", async () => {
    const { steps } = (await workflowOf(REVIEW_WORKFLOW)).jobs["review"] ?? { steps: [] };
    const run = stepNamed(steps, "Write a failed result when the runner wrote none").run ?? "";

    expect(run).toStartWith(`test -f ${REVIEW_RESULT_FILE} || `);
    expect(run.trimEnd()).toEndWith(`> ${REVIEW_RESULT_FILE}`);

    for (const variable of Object.values(REVIEW_VARIABLES)) {
      expect(run).toContain(`"$${variable}"`);
    }
  });
});

describe("the Merge bot's workflow", () => {
  test("a completed review job wakes the Merge bot for the PR its title names", async () => {
    const workflow = await workflowOf("merge-bot.yml");
    const review = await workflowOf(REVIEW_WORKFLOW);
    // A review run's `workflow_run.name` is its run-name, the PR's number: only its path names the workflow.
    const isReview = `github.event.workflow_run.path == '.github/workflows/${REVIEW_WORKFLOW}'`;
    const title = `(${isReview} && github.event.workflow_run.display_title)`;
    const job = workflow.jobs["merge-bot"];

    expect(review["run-name"]).toBe("${{ inputs.pr }}");
    expect(Schema.decodeUnknownSync(WorkflowRun)(workflow.on).workflow_run.workflows).toEqual(["CI", review.name]);
    expect(job?.if).toContain(`(${isReview} && github.event.workflow_run.event == 'workflow_dispatch')`);
    expect(`${job?.if ?? ""} ${workflow.concurrency?.group ?? ""}`).not.toContain("workflow_run.name");
    expect(workflow.concurrency?.group).toContain(title);
    expect(stepNamed(job?.steps ?? [], "Run the Merge bot").env?.["PR_NUMBER"]).toBe(
      `\${{ github.event.pull_request.number || inputs.pr || ${title} || '' }}`,
    );
  });

  test("CI's completion on a push to dev starts a Sweep, which reads dev's red from that run", async () => {
    const workflow = await workflowOf("merge-bot.yml");
    const job = workflow.jobs["merge-bot"];

    expect(job?.if).toContain(
      "(github.event.workflow_run.path == '.github/workflows/ci.yml' && github.event.workflow_run.event == 'push')",
    );
    expect(workflow.concurrency?.group).toStartWith(
      "merge-bot-${{ (github.event.workflow_run.event == 'push' && 'sweep') ||",
    );
    expect(stepNamed(job?.steps ?? [], "Run the Merge bot").env?.["RUN_EVENT"]).toBe(
      "${{ github.event.workflow_run.event }}",
    );
  });

  test("the App's token may dispatch the review job and read its runs and artifacts", async () => {
    const { steps } = (await workflowOf("merge-bot.yml")).jobs["merge-bot"] ?? { steps: [] };

    expect(stepNamed(steps, "Get the agents' App token").with?.["permission-actions"]).toBe("write");
  });
});

describe("CI's workflow", () => {
  test("each check the Land gate waits for is one of its jobs, under that name", async () => {
    const jobs = Object.keys((await workflowOf("ci.yml")).jobs);

    expect(CI_CHECKS.filter((check) => !jobs.includes(check))).toEqual([]);
  });
});

describe("the lab's logins", () => {
  test("the workflows and logins.ts name the same Owner, Author and App, so the Merge bot, the review job, the Stop hook and the relay trust the same logins", async () => {
    const mergeBot = (await workflowOf("merge-bot.yml")).jobs["merge-bot"]?.steps ?? [];
    const review = (await workflowOf(REVIEW_WORKFLOW)).jobs["review"]?.steps ?? [];
    const named = stepNamed(mergeBot, "Run the Merge bot").env ?? {};

    expect({ OWNER: named["OWNER"], AUTHOR_LOGIN: named["AUTHOR_LOGIN"], APP_LOGIN: named["APP_LOGIN"] }).toEqual({
      OWNER: OWNER_LOGIN,
      AUTHOR_LOGIN,
      APP_LOGIN: `${APP_LOGIN}[bot]`,
    });
    expect(stepNamed(review, "Read the earlier review threads").env?.["APP_LOGIN"]).toBe(`${APP_LOGIN}[bot]`);
  });
});
