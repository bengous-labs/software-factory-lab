import type { EngineInterface, Register, Timer } from "claude-code";

const COMMAND = "land";

const LABEL = "land-ok";

const GATE = "land-gate";

const REFRESH_MS = 30_000;

const FOLLOW_MS = 60 * 60_000;

const ACCEPTED_ORIGINS: ReadonlySet<string> = new Set(["composer", "bridge"]);

const NUMBER = /^#?(\d+)$/u;

const DENY =
  "land: land-ok is the Owner's Land approval. Only the Owner's own /land <n>, or the Owner on GitHub, puts it.";

type Row = {
  readonly url: string;
  gate: string;
  joinedAt: number;
};

type Band = {
  readonly rows: Map<string, Row>;
  timer: Timer | undefined;
};

type Ran = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string };

type Check = {
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
};

type Approval = { readonly state: string; readonly labels: readonly { readonly name: string }[]; readonly url: string };

type Progress = { readonly state: string; readonly statusCheckRollup: readonly Check[] };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lastLine = (text: string): string | undefined =>
  text
    .split("\n")
    .map((row) => row.trim())
    .findLast((row) => row !== "");

const gh = async ($: EngineInterface, args: readonly string[]): Promise<Ran> => {
  try {
    const child = $.process.spawn({ argv: ["gh", ...args] });
    let stdout = "";
    let stderr = "";

    for await (const { stream, text } of child) {
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    }

    const { code, signal } = await child.result;

    return code === 0
      ? { ok: true, stdout }
      : { ok: false, reason: lastLine(stderr) ?? `exit ${code ?? signal ?? "unknown"}` };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
};

const view = async <T,>(
  $: EngineInterface,
  n: string,
  fields: string,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> => {
  const ran = await gh($, ["pr", "view", n, "--json", fields]);

  if (!ran.ok) {
    return ran;
  }

  try {
    return { ok: true, value: JSON.parse(ran.stdout) as T };
  } catch {
    return { ok: false, reason: `gh pr view ${n} answered no JSON` };
  }
};

const gateOf = (checks: readonly Check[]): string => {
  const check = checks.find((entry) => (entry.name ?? entry.context) === GATE);

  if (check === undefined) {
    return "not posted";
  }

  const outcome =
    check.status === undefined ? check.state : check.status === "COMPLETED" ? check.conclusion : undefined;

  return outcome === undefined || outcome === "" || outcome === "PENDING" ? "in progress" : outcome.toLowerCase();
};

const isLabelWrite = (command: string): boolean => {
  const isLabelEdit = /\bgh\s+(?:pr|issue)\s+edit\b/u.test(command) && /--add-label\b/u.test(command);
  const method = /(?:^|\s)(?:-X|--method)(?:\s+|=)?['"]?([A-Za-z]+)/u.exec(command)?.[1];
  const isApiWrite =
    /\bgh\s+api\b/u.test(command) &&
    ((method !== undefined && method.toUpperCase() !== "GET") ||
      /(?:^|\s)(?:-[fF]|--field\b|--raw-field\b|--input\b)/u.test(command));
  const isLabelCommand = /\bgh\s+label\b(?!\s+list\b)/u.test(command);

  return command.includes(LABEL) && (isLabelEdit || isApiWrite || isLabelCommand);
};

const DISPLAY_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["mcp__ccd_turn__wrap_up", new Set(["recap", "ask"])],
  ["mcp__ccd_turn__update_plan", new Set(["items"])],
]);

const isMcpLabelWrite = (tool: string, input: object): boolean => {
  const shown = DISPLAY_FIELDS.get(tool);

  return Object.entries(input).some(
    ([key, value]) => shown?.has(key) !== true && (JSON.stringify(value)?.includes(LABEL) ?? false),
  );
};

const drop = ($: EngineInterface, band: Band, n: string, line?: string): void => {
  band.rows.delete(n);

  if (band.rows.size === 0) {
    band.timer?.cancel();
    band.timer = undefined;
  }

  if (line !== undefined) {
    $.ui.log(line);
  }

  $.ui.invalidate("ui.render");
};

const read = async ($: EngineInterface, band: Band, n: string, now: number): Promise<void> => {
  const viewed = await view<Progress>($, n, "state,statusCheckRollup");
  const row = band.rows.get(n);

  if (row === undefined) {
    return;
  }

  const progress = viewed.ok ? viewed.value : undefined;

  if (progress !== undefined) {
    row.gate = gateOf(progress.statusCheckRollup);
  }

  if (progress?.state === "MERGED") {
    drop($, band, n, `land: #${n} landed`);
  } else if (progress?.state === "CLOSED") {
    drop($, band, n, `land: #${n} was closed without landing`);
  } else if (now - row.joinedAt >= FOLLOW_MS) {
    drop($, band, n, `land: stopped following #${n} after 60 minutes, land-gate ${row.gate}`);
  }
};

const refresh = async ($: EngineInterface, band: Band): Promise<void> => {
  const now = await $.clock.now();
  await Promise.all([...band.rows.keys()].map(async (n) => read($, band, n, now)));
  $.ui.invalidate("ui.render");
};

const follow = async ($: EngineInterface, band: Band, n: string, url: string): Promise<void> => {
  const joinedAt = await $.clock.now();
  const row = band.rows.get(n);

  if (row === undefined) {
    band.rows.set(n, { url, gate: "not posted", joinedAt });
  } else {
    row.joinedAt = joinedAt;
  }

  band.timer ??= $.clock.every(REFRESH_MS, () => {
    void refresh($, band);
  });
  await read($, band, n, joinedAt);
  $.ui.invalidate("ui.render");
};

const approve = async ($: EngineInterface, band: Band, n: string): Promise<void> => {
  const viewed = await view<Approval>($, n, "state,labels,url");

  if (!viewed.ok) {
    $.ui.log(`land: #${n} does not read: ${viewed.reason}`);

    return;
  }

  const approval = viewed.value;

  if (approval.state !== "OPEN") {
    $.ui.log(`land: #${n} is ${approval.state}, nothing to approve`);

    return;
  }

  const removed = approval.labels.some(({ name }) => name === LABEL)
    ? await gh($, ["pr", "edit", n, "--remove-label", LABEL])
    : undefined;
  const added = removed === undefined || removed.ok ? await gh($, ["pr", "edit", n, "--add-label", LABEL]) : removed;

  if (!added.ok) {
    $.ui.log(`land: land-ok did not go on #${n}: ${added.reason}`);

    return;
  }

  $.ui.log(`land: land-ok is on #${n}, from your /land ${n}`);
  await follow($, band, n, approval.url);
};

export const register: Register = (on) => {
  const band: Band = { rows: new Map(), timer: undefined };

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Give the Owner's Land approval, land-ok, to a pull request",
      argumentHint: "<pull request number>",
      immediate: true,
    });

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($, e) => {
    const { kind } = e.origin;

    if (!ACCEPTED_ORIGINS.has(kind)) {
      $.ui.log(`land: /land runs only on the Owner's own typing, not on ${kind}`);

      return {};
    }

    const n = NUMBER.exec(e.args.trim())?.[1];

    if (n === undefined) {
      $.ui.log("land: /land takes one pull request number, as /land 120");

      return {};
    }

    await approve($, band, n);

    return {};
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || band.rows.size === 0) {
      return next(e);
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="column">
        {[...band.rows].map(([n, row]) => (
          <Box key={`row-${n}`}>
            <Text>{`#${n}  ${LABEL}  ${GATE}: ${row.gate}  `}</Text>
            <Link href={row.url}>Open</Link>
            <Text>{"  "}</Text>
            <Button
              key={`dismiss-${n}`}
              label="Dismiss"
              onPress={() => {
                drop($, band, n);
              }}
            />
          </Box>
        ))}
        {await next(e)}
      </Box>
    );
  });

  on("tool.call", { tool: "Bash" }, (_, e, next) => (isLabelWrite(e.command) ? { deny: DENY } : next(e)));

  on("tool.call", { tool: "Monitor" }, (_, e, next) =>
    e.command !== undefined && isLabelWrite(e.command) ? { deny: DENY } : next(e),
  );

  on("tool.call", (_, e, next) =>
    e.tool.startsWith("mcp__") && isMcpLabelWrite(e.tool, e) ? { deny: DENY } : next(e),
  );
};
