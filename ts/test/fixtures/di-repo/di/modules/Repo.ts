import { createModule } from "../di";
import { DI_TOKENS } from "../tokens";
import { PrismaRepo } from "../../PrismaRepo";
export const repoModule = createModule();
const token = DI_TOKENS.REPO;
repoModule.bind(token).toClass(PrismaRepo, []);
