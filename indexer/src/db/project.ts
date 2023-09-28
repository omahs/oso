import { In } from "typeorm";
import { AppDataSource } from "./data-source.js";
import { ArtifactType, Project } from "./orm-entities.js";

export const ProjectRepository = AppDataSource.getRepository(Project).extend({
  async allFundableProjectsWithAddresses() {
    return await this.find({
      relations: {
        artifacts: true,
      },
      where: {
        artifacts: {
          type: In([ArtifactType.EOA_ADDRESS, ArtifactType.SAFE_ADDRESS]),
        },
      },
    });
  },
});