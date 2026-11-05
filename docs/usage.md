# Usage

`todo` keeps a task list in a JSON file, `todo.json` in the current directory, or the file `TODO_FILE` names.

```bash
bun app/src/cli.ts add "write the spec"   # added #1
bun app/src/cli.ts list                    # [ ] #1 write the spec
bun app/src/cli.ts done 1                  # done #1
bun app/src/cli.ts list --all              # [x] #1 write the spec
bun app/src/cli.ts count                   # 0 open
bun app/src/cli.ts rename 1 "final spec"   # renamed #1
```

`list` shows open tasks; `--all` shows every task; `--done` shows only the done ones. `--done` and `--all` cannot be combined. `count` prints how many tasks are open.

## Where the tasks live

Each command reads and writes the whole file. Two `todo` commands run at the same time can lose a write.

## Troubleshooting

When `todo` cannot read the task file, the command stops before it writes. The file keeps its content.

The message names the file path. It is `TODO_FILE`, or `todo.json` when `TODO_FILE` is not set.

### The file is not valid JSON

`todo` does not print a `todo:` message. It prints a Bun `SyntaxError` stack trace that names the JSON error, and it exits with status 1.

Open the file and fix the syntax, for example a missing comma or quote. To start again with an empty list, move the file aside. The next `add` creates a new file.

### The file has another format version

`todo` prints this message:

```text
todo: <path>: format version <found>, expected 1
```

`<found>` is the `version` value in the file. It shows `undefined` when the file has no `version` field, as for a JSON array.

The file was written by another version of `todo`, or it is not a task file. Restore the file from a backup or from version control. Changing the `version` value by hand does not convert the tasks.

### The tasks do not match the format

`todo` prints this message:

```text
todo: <path>: tasks is not a list of tasks
```

The file has no `tasks` array, or one task lacks a field of the right type. Each task needs a numeric `id`, a string `title` and a boolean `done`:

```json
{
  "version": 1,
  "tasks": [{ "id": 1, "title": "write the spec", "done": false }]
}
```

### The file is not an object

`todo` prints `todo: <path>: not an object` when the file holds a JSON value that is not an object, such as `null`, `5` or `"text"`. Replace the content with a file in the format above.
