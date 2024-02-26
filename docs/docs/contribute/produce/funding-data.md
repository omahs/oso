---
title: Share Funding Data
sidebar_position: 2
---

Upload CSV files that help us link funding data to OSS projects.

We maintain a [master CSV file](https://github.com/opensource-observer/insights/blob/main/community/datasets/funding_data/funding_data.csv) that maps OSO project names to funding sources. It includes grants, direct donations, and other forms of financial support. We are looking for data from a variety of sources, including both crypto and non-crypto funding platforms.

We are coordinating with several efforts to collect, clean, and visualize this data, including [RegenData.xyz](https://regendata.xyz/), [Gitcoin Grants Data Portal](https://davidgasquez.github.io/gitcoin-grants-data-portal/), and [Crypto Data Bytes](https://dune.com/cryptodatabytes/crypto-grants-analysis).

## Contributing Funding Data

---

If you have funding data you would like to contribute, please prepare a CSV file with the data you have (it doens't need to cover 100% of fields) and submit a pull request with a CSV file to be added to our [`funding_data/uploads` directory](https://github.com/opensource-observer/insights/tree/main/community/datasets/funding_data/uploads). Try to include as many of the following columns as possible:

- `oso_slug`: The OSO project slug.
- `project_name`: The name of the project (according to the funder's data).
- `project_id`: The unique identifier for the project (according to the funder's data).
- `project_url`: The URL of the project's grant application or profile.
- `project_address`: The address the project used to receive the grant.
- `funder_name`: The name of the funding source.
- `funder_round_name`: The name of the funding round or grants program.
- `funder_round_type`: The type of funding this round is (eg, retrospective, builder grant, etc).
- `funder_address`: The address of the funder.
- `funding_amount`: The amount of funding.
- `funding_currency`: The currency of the funding amount.
- `funding_network`: The network the funding was provided on (eg, Mainnet, Optimism, Arbitrum, fiat, etc).
- `funding_date`: The date of the funding event.

## Accessing Funding Data

---

We are currently collecting funding data from the following networks:

- Arbitrum
- Gitcoin Grants
- Octant
- Optimism

We are looking for help with:

- clr.fund
- DAO Drops
- Ethereum Foundation
- Giveth
- Open Collective

## Grants Registry

---

:::warning
This is a working -- and very incomplete -- registry of onchain ecosystem grant funds.
:::

| Funding Platform    | Mechanism         | Chain    | Contract Address                           |
| ------------------- | ----------------- | -------- | ------------------------------------------ |
| Ethereum Foundation | Grants Provider   | Ethereum | 0x9ee457023bb3de16d51a003a247baead7fce313d |
| Gitcoin Grants      | Bulk Checkout     | Ethereum | 0x7d655c57f71464B6f83811C55D84009Cd9f5221C |
| Gitcoin Grants      | Bulk Checkout     | Polygon  | 0xb99080b9407436eBb2b8Fe56D45fFA47E9bb8877 |
| Gitcoin Grants      | cGrants?          | Ethereum | 0xdf869FAD6dB91f437B59F1EdEFab319493D4C4cE |
| Gitcoin Grants      | GR8 Match Payout  | Ethereum | 0xf2354570be2fb420832fb7ff6ff0ae0df80cf2c6 |
| Gitcoin Grants      | GR9 Match Payout  | Ethereum | 0x3342e3737732d879743f2682a3953a730ae4f47c |
| Gitcoin Grants      | GR10 Match Payout | Ethereum | 0x3ebaffe01513164e638480404c651e885cca0aa4 |
| Gitcoin Grants      | GR11 Match Payout | Ethereum | 0x0ebd2e2130b73107d0c45ff2e16c93e7e2e10e3a |
| Gitcoin Grants      | GR12 Match Payout | Ethereum | 0xab8d71d59827dcc90fedc5ddb97f87effb1b1a5b |
| Gitcoin Grants      | GR13 Match Payout | Ethereum | 0xf63fd0739cb68651efbd06bccb23f1a1623d5520 |
| Gitcoin Grants      | GR14 Match Payout | Ethereum | 0x2878883dd4345c7b35c13fefc5096dd400814d91 |
| Gitcoin Grants      | GR15 Match Payout | Ethereum | 0xc8aca0b50f3ca9a0cbe413d8a110a7aab7d4c1ae |
| DAO Drops           | DAO Drops 1       | Ethereum | 0xafe5f7a1d1c173b311047cdc93729013ad03de0c |
| Optimism RPGF       | Retro PGF         | Optimism | 0x19793c7824be70ec58bb673ca42d2779d12581be |
| Optimism Foundation | Direct Grants     | Optimism | 0x2501c477D0A35545a387Aa4A3EEe4292A9a8B3F0 |