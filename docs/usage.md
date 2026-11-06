# Usage

`todo` keeps a task list in a JSON file, `todo.json` in the current directory, or the file `TODO_FILE` names.

```bash
bun app/src/cli.ts add "write the spec"   # added #1
bun app/src/cli.ts list                    # [ ] #1 write the spec
bun app/src/cli.ts done 1                  # done #1
bun app/src/cli.ts list --all              # [x] #1 write the spec
bun app/src/cli.ts count                   # 0 open
bun app/src/cli.ts rename 1 "final spec"   # renamed #1
bun app/src/cli.ts undone 1                # undone #1
```

`list` shows open tasks; `--all` shows every task; `--done` shows only the done ones. `--done` and `--all` cannot be combined. `count` prints how many tasks are open.

## Where the tasks live

`todo` reads and writes `todo.json` in the current directory. Set `TODO_FILE` to a path to use another file. A relative path is taken from the current directory. The file is created by the first command that adds or changes a task.

Each command reads and writes the whole file. Two `todo` commands run at the same time can lose a write.

## Troubleshooting

When `todo` cannot read the task file, the command stops before it writes. The file keeps its content.

The message names the file path. It is `TODO_FILE`, or `todo.json` when `TODO_FILE` is not set. It then says what was expected and, on the next line, where in the file: `at ["tasks"][0]["done"]` is the `done` field of the first task. `todo` exits with status 1.

### The file is not valid JSON

```text
todo: <path>: Expected a valid JSON string
```

Open the file and fix the syntax, for example a missing comma or quote. To start again with an empty list, move the file aside. The next `add` creates a new file.

### The file is not an object

```text
todo: <path>: Expected object
```

The file holds a JSON value that is not an object, such as `[]`, `null`, `5` or `"text"`. Replace the content with a file in the format below.

### The file has another format version

```text
todo: <path>: Expected 1 | 2
  at ["version"]
```

The `version` value is neither 1 nor 2. When the file has no `version` field, the first line reads `Missing key`.

The file was written by another version of `todo`, or it is not a task file. Restore the file from a backup or from version control. Changing the `version` value by hand does not convert the tasks.

### The tasks do not match the format

```text
todo: <path>: Missing key
  at ["tasks"][0]["done"]
```

The file has no `tasks` array, or a task lacks a field or holds one of the wrong type. Each task needs a numeric `id`, a string `title` and a boolean `done`. A version 2 task may carry `createdAt`, the time it was added as an ISO timestamp such as `2026-11-05T09:00:00.000Z`; a version 1 task carries none:

```json
{
  "version": 2,
  "tasks": [{ "id": 1, "title": "write the spec", "done": false, "createdAt": "2026-11-05T09:00:00.000Z" }]
}
```

A key the format does not name is dropped when the file is read, and so from the file on the next save.

## Two task lists

Set `TODO_FILE` for a command to pick the file it uses. Each file keeps its own list, and its ids start at #1:

```bash
TODO_FILE=work.json bun app/src/cli.ts add "write the spec"   # added #1
TODO_FILE=work.json bun app/src/cli.ts add "review the PR"    # added #2
TODO_FILE=home.json bun app/src/cli.ts add "buy milk"         # added #1
```

`TODO_FILE=work.json bun app/src/cli.ts list` prints:

```
[ ] #1 write the spec
[ ] #2 review the PR
```

`TODO_FILE=home.json bun app/src/cli.ts list` prints `[ ] #1 buy milk`, and `home.json` never shows the work tasks.

To use one list for a whole shell session, run `export TODO_FILE=work.json` once.
