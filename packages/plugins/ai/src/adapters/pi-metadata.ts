import { piCatalog, piSkills } from '@axterm/engine-pi-core';
import { aiSkillSchema, piCatalogProviderSchema } from '@axterm/plugin-api/ai';
/** Readonly fixed metadata; execution always goes through ctx.engines. */
export const piMetadata = {
  catalog: () => piCatalogProviderSchema.array().parse(piCatalog()),
  skills: () => piSkills().map(({ body: _body, ...skill }) => aiSkillSchema.parse(skill)),
  instructions: (useCase: string) => {
    const skill = piSkills().find((item) => item.useCase === useCase);
    return skill ? `<skill name="${skill.id}">\n${skill.body}\n</skill>` : undefined;
  },
};
