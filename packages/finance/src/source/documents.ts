/**
 * Every GraphQL document the API source sends, in one file.
 *
 * These target an **unofficial** API. They are written as full query text (not
 * persisted-query hashes) precisely so that adapting to a schema change is an
 * edit here rather than a packet capture. When the provider moves a field, the
 * source raises `schema_drift`, the monthly batch exits clean and blocked, and
 * the fix is confined to this file.
 *
 * The field selections are deliberately minimal: every field asked for is a
 * field that can break. Anything not needed by the review is not requested.
 */

/** Cheapest authenticated round-trip — the preflight probe. */
export const ME_QUERY = /* GraphQL */ `
  query AssistIdentityProbe {
    me {
      id
    }
  }
`;

export const TRANSACTIONS_QUERY = /* GraphQL */ `
  query AssistTransactions(
    $limit: Int!
    $offset: Int!
    $orderBy: TransactionOrdering
    $filters: TransactionFilterInput
  ) {
    allTransactions(filters: $filters) {
      totalCount
      results(offset: $offset, limit: $limit, orderBy: $orderBy) {
        id
        date
        amount
        pending
        needsReview
        notes
        plaidName
        category {
          id
          name
        }
        merchant {
          id
          name
        }
        account {
          id
          displayName
        }
        tags {
          id
          name
        }
      }
    }
  }
`;

export const ACCOUNTS_QUERY = /* GraphQL */ `
  query AssistAccounts {
    accounts {
      id
      displayName
      currentBalance
      isAsset
      type {
        name
      }
      subtype {
        name
      }
      institution {
        name
      }
    }
  }
`;

export const CATEGORIES_QUERY = /* GraphQL */ `
  query AssistCategories {
    categories {
      id
      name
      group {
        id
        name
      }
    }
  }
`;

/**
 * The one mutation. Reached only from an explicit, human-initiated apply of an
 * accepted suggestion — never from the scheduled batch.
 */
export const UPDATE_TRANSACTION_MUTATION = /* GraphQL */ `
  mutation AssistUpdateTransaction($input: UpdateTransactionMutationInput!) {
    updateTransaction(input: $input) {
      transaction {
        id
        notes
        category {
          id
          name
        }
      }
      errors {
        message
        fieldErrors {
          field
          messages
        }
      }
    }
  }
`;
