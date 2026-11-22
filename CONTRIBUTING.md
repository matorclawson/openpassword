# Contributing to OpenPassword

Dreamhuggers requires an executed contributor agreement granting it the right to relicense the contribution before accepting an external change. Maintainers verify that the contributor and, where applicable, their employer are covered before merge. The contributor retains ownership. A pull request or sign-off alone does not establish that an agreement has been executed.

Run `make verify`. Changes to the broker wire format require a compatibility note and a regression test. A connector contribution should document its upstream origin, accepted arguments, credential type, provider effects and response handling. Keep fixtures synthetic. Do not include customer data, provider credentials or internal infrastructure details.
