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
