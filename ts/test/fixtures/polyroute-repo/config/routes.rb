# Rails routing — the served path is IMPLICIT. `resources :payments` under two namespaces GENERATES
# `/api/admin/payments` (+ `/api/admin/payments/:id`); the literal string appears NOWHERE in the backend.
# A deterministic adapter would have to reimplement Rails' routing DSL (namespaces, resources, member/
# collection, constraints) to recover it — exactly the work the LLM does from convention knowledge.
Rails.application.routes.draw do
  namespace :api do
    namespace :admin do
      resources :payments, only: [:index, :show]
    end
  end
end
