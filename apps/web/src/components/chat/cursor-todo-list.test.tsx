import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CursorTodoList } from "./cursor-todo-list";

describe("CursorTodoList", () => {
  it("renders merged todo statuses", () => {
    render(
      <CursorTodoList
        todos={[
          { id: "1", content: "Setup", status: "completed" },
          { id: "2", content: "Write tests", status: "in_progress" },
        ]}
      />,
    );
    expect(screen.getByText("Setup")).toBeInTheDocument();
    expect(screen.getByText("Write tests")).toBeInTheDocument();
  });
});
