import { AppError } from "../errors";
import type { SkillDefinition } from "../types";

export class SkillCatalog {
  private readonly skillMap: Map<string, SkillDefinition>;
  private readonly defaultSkillName: string;

  constructor(skills: SkillDefinition[]) {
    this.skillMap = new Map(skills.map((skill) => [skill.name, skill]));
    this.defaultSkillName = skills[0]?.name ?? "general";
  }

  list(): SkillDefinition[] {
    return [...this.skillMap.values()];
  }

  resolve(name?: string): SkillDefinition {
    const skillName = name ?? this.defaultSkillName;
    const skill = this.skillMap.get(skillName);

    if (!skill) {
      throw new AppError(400, "invalid_skill", `Skill "${skillName}" is not allowed.`);
    }

    return skill;
  }
}
