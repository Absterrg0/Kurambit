// The stage a role belongs to; blind samples and comparators belong to the
// stage they run in, so they take the group before them.
const groupOf = (role: string, previous: string | null): string | null => {
  const [head = role, ...rest] = role.split("-");
  const tail = rest.join("-");
  const round = /^(\d+)b?$/.exec(tail)?.[1];
  switch (head) {
    case "vision":
      return "Vision";
    case "proto":
      return "Prototypes";
    case "sample":
    case "compare":
      return previous === "Prototypes" ? "Blind pick" : previous;
    case "plan":
      return "Plan";
    case "art":
      return "Art";
    case "builder":
      if (tail === "build") return "First build";
      return round === undefined ? previous : `Round ${round}`;
    case "tester":
    case "reviewer":
    case "ship":
      return round === undefined ? previous : `Round ${round}`;
    default:
      return previous;
  }
};

/** Each role, in launch order, with the run stage or round it ran in. */
export const withRoleGroups = <T extends { readonly role: string }>(
  roles: ReadonlyArray<T>,
): Array<T & { readonly group: string }> => {
  let previous: string | null = null;
  return roles.map((entry) => {
    const group = groupOf(entry.role, previous) ?? "Run";
    previous = group;
    return { ...entry, group };
  });
};
