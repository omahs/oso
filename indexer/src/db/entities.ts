import _ from "lodash";
import { Artifact, ArtifactType, ArtifactNamespace } from "./orm-entities.js";
import { Project, Collection, URL, BlockchainAddress } from "oss-directory";
import { logger } from "../utils/logger.js";
import {
  isGitHubOrg,
  isGitHubRepo,
  parseGitHubUrl,
  parseNpmUrl,
} from "../utils/parsing.js";
import { getNpmUrl } from "../utils/format.js";
import { safeCast, ensure, filterFalsy } from "../utils/common.js";
import { getOwnerRepos } from "../events/github/getOrgRepos.js";
import { ProjectRepository } from "./project.js";
import { CollectionRepository } from "./collection.js";
import { In } from "typeorm";
import { ArtifactRepository } from "./artifacts.js";

/**
 * Upsert a Collection from oss-directory
 * Pre-condition: all of the project slugs need to already be in the database
 * @param ossCollection
 */
async function ossUpsertCollection(ossCollection: Collection) {
  const { slug, name, projects: projectSlugs } = ossCollection;

  // Get all of the projects
  const projects = await ProjectRepository.find({
    where: {
      slug: In(projectSlugs),
    },
  });

  // Check that all Projects are already in the database
  if (projects.length != projectSlugs.length) {
    logger.warn(
      `Not all of the projects for collection ${slug} are in the database. Please add all projects first`,
    );
  }

  // Upsert into the database
  const collection = await CollectionRepository.upsert(
    [
      {
        name: name,
        slug: slug,
        projects: projects.map((p) => ({
          id: p.id,
        })),
      },
    ],
    ["slug"],
  );
  return collection;
}

/**
 * Upsert a Project from oss-directory
 * @param ossProj
 * @returns
 */
async function ossUpsertProject(ossProj: Project) {
  const { slug, name, github, npm, blockchain } = ossProj;

  // Create all of the missing artifacts first
  // Note: this will only create missing artifacts, not update existing ones
  const artifacts = [
    // Create GitHub artifacts
    ...(await ossCreateGitHubArtifacts(github)),
    // Create npm artifacts
    ...(await ossCreateNpmArtifacts(npm)),
    // Create Optimism artifacts
    ...(await ossCreateBlockchainArtifacts(blockchain)),
  ];

  // Then upsert the project with the relations
  const project = await ProjectRepository.upsert(
    [
      {
        slug: slug,
        name: name,
        artifacts: artifacts.map((a) => ({ id: a.id })),
      },
    ],
    ["slug"],
  );

  // FIXME this needs to be added back in.
  // Remove any artifact relations that are no longer valid
  /*
  await prisma.projectsOnArtifacts.deleteMany({
    where: {
      projectId: project.id,
      artifactId: {
        notIn: artifacts.map((a) => a.id),
      },
    },
  });
  */

  return project;
}

/**
 * Upsert a GitHub resource from oss-directory
 */
async function ossCreateGitHubArtifacts(
  urlObjects?: URL[],
): Promise<Artifact[]> {
  if (!urlObjects) {
    return safeCast<Artifact[]>([]);
  }

  const urls = urlObjects.map((o) => o.url);
  const repoUrls = urls.filter(isGitHubRepo);
  const orgUrls = urls.filter(isGitHubOrg);

  // Check for invalid URLs
  if (orgUrls.length + repoUrls.length !== urls.length) {
    const nonConfirmingUrls = urls.filter(
      (u) => !isGitHubOrg(u) && !isGitHubRepo(u),
    );
    const sep = "\n\t";
    logger.warn(`Invalid GitHub URLs:${sep}${nonConfirmingUrls.join(sep)}`);
  }

  // Flatten all GitHub orgs
  const orgNames = filterFalsy(
    orgUrls.map(parseGitHubUrl).map((p) => p?.owner),
  );
  const orgRepos = _.flatten(await Promise.all(orgNames.map(getOwnerRepos)));
  const orgRepoUrls = orgRepos.map((r) => r.url);
  const allRepos = [...repoUrls, ...orgRepoUrls];
  const parsedRepos = allRepos.map(parseGitHubUrl);
  const data = parsedRepos.map((p) => ({
    type: ArtifactType.GIT_REPOSITORY,
    namespace: ArtifactNamespace.GITHUB,
    name: ensure<string>(p?.slug, `Invalid parsed GitHub URL: ${p}`),
    url: ensure<string>(p?.url, `Invalid parsed GitHub URL: ${p}`),
  }));
  const slugs = filterFalsy(parsedRepos.map((p) => p?.slug));

  const newArtifacts = Artifact.create(data);
  logger.debug("Upserting artifacts");
  // Create records
  const result = await ArtifactRepository.upsertMany(newArtifacts);
  const createCount = result.identifiers.length;

  logger.debug(
    `... created ${createCount}/${data.length} GitHub artifacts (skip duplicates)`,
  );

  // Now get all of the artifacts
  const artifacts = ArtifactRepository.find({
    where: {
      type: ArtifactType.GIT_REPOSITORY,
      namespace: ArtifactNamespace.GITHUB,
      name: In(slugs),
    },
  });
  return artifacts;
}

/**
 * Upsert an npm artifact from oss-directory
 * @param ossUrl
 * @returns
 */
async function ossCreateNpmArtifacts(urlObjects?: URL[]) {
  if (!urlObjects) {
    return safeCast<Artifact[]>([]);
  }

  const urls = urlObjects.map((o) => o.url);
  const parsed = urls.map(parseNpmUrl);
  const data = parsed.map((p) => ({
    type: ArtifactType.NPM_PACKAGE,
    namespace: ArtifactNamespace.NPM_REGISTRY,
    name: ensure<string>(p?.slug, `Invalid parsed npm URL: ${p}`),
    url: ensure<string>(p?.url, `Invalid parsed npm URL: ${p}`),
  }));
  const slugs = filterFalsy(parsed.map((p) => p?.slug));

  // Create records
  const result = await ArtifactRepository.upsertMany(data);
  const createCount = result.identifiers.length;
  logger.debug(
    `... inserted ${createCount}/${data.length} npm artifacts (skip duplicates)`,
  );

  // Now get all of the artifacts
  const artifacts = await ArtifactRepository.find({
    where: {
      type: ArtifactType.NPM_PACKAGE,
      namespace: ArtifactNamespace.NPM_REGISTRY,
      name: In(slugs),
    },
  });
  return artifacts;
}

/**
 * Upsert a blockchain address artifact from oss-directory
 * @param ossAddr
 * @param artifactNamespace
 * @returns
 */
async function ossCreateBlockchainArtifacts(addrObjects?: BlockchainAddress[]) {
  if (!addrObjects) {
    return safeCast<Artifact[]>([]);
  }

  const data = addrObjects.flatMap((o) => {
    return o.networks.map((network) => {
      return {
        type:
          o.tags.indexOf("eoa") !== -1
            ? ArtifactType.EOA_ADDRESS
            : o.tags.indexOf("safe") !== -1
            ? ArtifactType.SAFE_ADDRESS
            : o.tags.indexOf("factory") !== -1
            ? ArtifactType.FACTORY_ADDRESS
            : o.tags.indexOf("contract") !== -1
            ? ArtifactType.CONTRACT_ADDRESS
            : ArtifactType.EOA_ADDRESS,
        // Hacky solution for now. We should we address after the typeorm migration
        namespace:
          network === "optimism"
            ? ArtifactNamespace.OPTIMISM
            : ArtifactNamespace.ETHEREUM,
        name: o.address,
      };
    });
  });
  const addresses = data.map((d) => d.name);

  // Create records
  const result = await ArtifactRepository.upsertMany(data);
  const createCount = result.identifiers.length;
  logger.debug(
    `... inserted ${createCount}/${data.length} blockchain artifacts (skip duplicates)`,
  );

  // Now get all of the artifacts
  const artifacts = await ArtifactRepository.find({
    where: {
      name: In(addresses),
    },
  });
  return artifacts;
}

/**
 * Gets a collection by a slug
 * @param slug
 * @returns
 */
async function getCollectionBySlug(slug: string) {
  return await CollectionRepository.findOne({ where: { slug } });
}

/**
 * Gets a project by a slug
 * @param slug
 * @returns
 */
async function getProjectBySlug(slug: string) {
  return await ProjectRepository.findOne({ where: { slug } });
}

/**
 * Gets an artifact by name
 * @param fields
 * @returns
 */
async function getArtifactByName(fields: {
  namespace: ArtifactNamespace;
  name: string;
}): Promise<Artifact | null> {
  const { namespace, name } = fields;
  const result = await ArtifactRepository.findOne({
    where: {
      namespace: namespace,
      name: name,
    },
  });
  return result;
}

/**
 * Generic upsert for an artifact
 * @param address
 * @param type
 * @param ns
 * @returns
 */
async function upsertArtifact(fields: {
  namespace: ArtifactNamespace;
  type: ArtifactType;
  name: string;
  url?: string;
  details?: any;
}) {
  return await ArtifactRepository.upsert(
    [{ ...fields }],
    ["name", "namespace"],
  );
}

/**
 * Upsert a GitHub repo artifact
 * @param slug
 * @param url
 * @returns
 */
async function upsertGitHubRepo(slug: string, url: string) {
  return await upsertArtifact({
    type: ArtifactType.GIT_REPOSITORY,
    namespace: ArtifactNamespace.GITHUB,
    name: slug,
    url,
  });
}

/**
 * Upsert an npm package artifact
 * @param packageName
 * @returns
 */
async function upsertNpmPackage(packageName: string) {
  return await upsertArtifact({
    type: ArtifactType.NPM_PACKAGE,
    namespace: ArtifactNamespace.NPM_REGISTRY,
    name: packageName,
    url: getNpmUrl(packageName),
  });
}

export {
  getCollectionBySlug,
  getProjectBySlug,
  getArtifactByName,
  ossUpsertProject,
  ossUpsertCollection,
  upsertGitHubRepo,
  upsertNpmPackage,
};
