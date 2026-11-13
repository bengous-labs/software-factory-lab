import { describe, expect, test } from "bun:test";

import {
  API_WORKER_VARIABLE,
  AUTHOR_VARIABLE,
  isApiWorker,
  isAuthor,
  isWorker,
  ROLE_VARIABLE,
} from "./author-session.ts";

describe("isAuthor", () => {
  test("only LAB_AUTHOR=1 makes a session an Author", () => {
    expect(isAuthor({ [AUTHOR_VARIABLE]: "1" })).toBe(true);
    expect(isAuthor({ [AUTHOR_VARIABLE]: "0" })).toBe(false);
    expect(isAuthor({ [AUTHOR_VARIABLE]: "true" })).toBe(false);
    expect(isAuthor({})).toBe(false);
  });
});

describe("isApiWorker", () => {
  test("only LAB_API_WORKER=1 makes a session an API Worker's", () => {
    expect(isApiWorker({ [API_WORKER_VARIABLE]: "1" })).toBe(true);
    expect(isApiWorker({ [API_WORKER_VARIABLE]: "0" })).toBe(false);
    expect(isApiWorker({ [API_WORKER_VARIABLE]: "true" })).toBe(false);
    expect(isApiWorker({ [AUTHOR_VARIABLE]: "1" })).toBe(false);
    expect(isApiWorker({})).toBe(false);
  });
});

describe("isWorker", () => {
  test("an Author plays a Worker, and so does a session of the Worker bench, which is no Author", () => {
    expect(isWorker({ [AUTHOR_VARIABLE]: "1" })).toBe(true);
    expect(isWorker({ [ROLE_VARIABLE]: "worker" })).toBe(true);
    expect(isAuthor({ [ROLE_VARIABLE]: "worker" })).toBe(false);
  });

  test("any other role, or none, plays no Worker", () => {
    expect(isWorker({ [ROLE_VARIABLE]: "owner" })).toBe(false);
    expect(isWorker({})).toBe(false);
  });
});
