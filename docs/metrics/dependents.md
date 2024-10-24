# Dependents

> This document aims to clarify the definition and categorization of software package dependents. This metric can highlight the usefulness of a given open source software project to other projects in the ecosystems.

A **dependent** refers to a software package, module, or project that is included as a dependency in another project's source code. In other words, the project provides other projects with classes, methods, or resources that they rely on to function properly.

Dependents may also be referred to as *reverse dependencies*.

## Direct vs. Indirect Dependents

Dependents can be classified as either:
- **Direct Dependents**: These are packages that explicitly declare the parent package in their list of dependencies.
- **Indirect Dependents**: Indirect dependents rely on the parent package through another intermediary package. For instance, if Package A depends on Package B, and Package B depends on Package C, then Package A becomes an indirect dependent of Package C.

## Developer Dependencies

Numerous package managers, including npm and Crates, differentiate between dependencies required for production code execution and **developer dependencies** solely necessary for local development and testing.

An example of an npm `package.json` file that incorporates developer dependencies is as follows:

```json
"name": "my_package",
"version": "1.0.0",
"dependencies": {
  "my_dep": "^1.0.0",
  "another_dep": "~2.2.0"
},
"devDependencies" : {
  "my_test_framework": "^3.1.0",
  "another_dev_dep": "1.0.0 - 1.2.0"
}
```

## Setting Constraints on the Dependent/Dependency Ecosystem

Within the context of OS Observer, we have currently imposed the following constraints on our dependent/dependency mapping:

1. We only consider direct dependents, omitting indirect ones from our indexing.
2. Our focus is solely on packages essential for production. Developer dependencies are disregarded in our dependency graph.
3. The scope of the dependency mapping is limited to a designated collection or the union of a collection set. This approach maintains manageable indexing processes on our end and fosters a clearer understanding of the most critical relationships among packages within an ecosystem.

Without these constraints, it's possible for certain packages to become indirect dependents or dependencies for nearly every piece of open-source software code written.
 
### Example

> Note: this is made-up example. We'll add a real one based on a real depedency graph soon.

Consider a collection of "Ethereum Developer Tools" with projects like `ethers` and `wagmi` and a collection called "Optimism Applications" that includes user-facing applications like `velodrome-finance` and `zora`. 

Assuming `velodrome-finance` includes `ethers` in its dependencies and `zora` includes both `ethers` and `wagmi`, then `ethers` would have two dependents and `wagmi` would have one. These relationships are shown in the diagram below.

```
Ecosystems: Ethereum Developer Tools & Optimism Applications
    |
    |----> Project: ethers
    |          |
    |          |----> Dependent: velodrome-finance
    |          |----> Dependent: zora    
    |
    |----> Project: wagmi
               |
               |----> Dependent: zora
    |
    |----> Project: velodrome-finance
    |          |
    |          |----> Dependency: ethers
    |
    |----> Project: zora
               |
               |----> Dependency: ethers
               |----> Dependency: wagmi
```

## Dependent Metrics

In addition to mapping projects and their dependents, we also capture the following data about a project's dependents:

- **Current Dependents**: the number of dependent projects as of the most recent indexing run. (We do not support historic analysis of how dependency graphs have changed over time.)
- **Downloads**: the total number of times all packages released by the project have been downloaded over a given time period.
