import type { CursorTodo } from "@dev-anywhere/shared";
import { cn } from "@/lib/utils";

interface CursorTodoListProps {
  todos: CursorTodo[];
}

function statusMark(status: CursorTodo["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "→";
    case "cancelled":
      return "×";
    default:
      return "○";
  }
}

export function CursorTodoList({ todos }: CursorTodoListProps) {
  if (todos.length === 0) return null;
  return (
    <div
      data-slot="cursor-todo-list"
      className="rounded-md border border-border bg-card px-3 py-2 text-xs"
    >
      <div className="mb-1 font-medium">Cursor Todos</div>
      <ul className="space-y-1">
        {todos.map((todo) => (
          <li
            key={todo.id}
            className={cn(
              "flex gap-2",
              todo.status === "completed" && "text-muted-foreground line-through",
              todo.status === "cancelled" && "text-muted-foreground",
              todo.status === "in_progress" && "text-foreground",
            )}
          >
            <span aria-hidden="true">{statusMark(todo.status)}</span>
            <span>{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
