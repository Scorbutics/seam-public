# Rails controller ACTION (the route handler). Anchored here, discover_keys (the LLM) infers the RESTful
# path this action serves from the namespaced class + action name and proposes it as an `http-route` key —
# grounding on the JS `fetch` the floor already indexed. No Rails adapter, no path literal in this file.
module Api
  module Admin
    class PaymentsController < ApplicationController
      def index
        @payments = Payment.order(created_at: :desc)
        render json: @payments
      end
    end
  end
end
