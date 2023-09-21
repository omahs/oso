import * as dotenv from "dotenv";
dotenv.config();

export const requireEnv = (identifier: string) => {
  const value = process.env[identifier];

  if (!value) {
    throw new Error(`Required env var ${identifier} does not exist`);
  }
  return value;
};

export const DATABASE_URL = requireEnv("DATABASE_URL");
export const DB_HOST = requireEnv("DB_HOST");
export const DB_PORT = requireEnv("DB_PORT");
export const DB_USER = requireEnv("DB_USER");
export const DB_PASSWORD = requireEnv("DB_PASSWORD");
export const DB_DATABASE = requireEnv("DB_DATABASE");
export const GITHUB_GRAPHQL_API = requireEnv("X_GITHUB_GRAPHQL_API");
export const GITHUB_TOKEN = requireEnv("X_GITHUB_TOKEN");
export const DUNE_API_KEY = requireEnv("DUNE_API_KEY");
