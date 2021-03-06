'use strict'
const { promisify } = require('util')
const jexl = require('jexl')

class Client {
  /**
   * @param {Object} config
   */
  constructor ({ config, tracedRequest, log }) {
    this.baseUri = `https://${config.zone}-search.doofinder.com/5/`
    this.hashId = config.hashId
    this.authKey = config.authKey
    this.filterMap = config.filterMap
    this.filterMapFlipped = config.filterMap ? Object.keys(this.filterMap).reduce((acc, k) => {
      acc[this.filterMap[k]] = k
      return acc
    }, {}) : {}

    try {
      this.productIdKey = jexl.compile(config.productIdKey)
    } catch (err) {
      this.log.error({ err }, 'Doofinder productIdKey expression is broken')
      this.productIdKey = config.productIdKey
    }

    this.tracedRequest = tracedRequest
    this.log = log
  }

  /**
   * @param {Object} responseItem
   * @returns {*}
   */
  getProductId (responseItem) {
    if (typeof this.productIdKey !== 'string') {
      try {
        return this.productIdKey.evalSync(responseItem)
      } catch (err) {
        this.log.error({ err }, 'Doofinder product id is not found')
        return null
      }
    }
    return responseItem[this.productIdKey]
  }

  /**
   * @param {Object} params
   * @param {String} endpoint
   *
   * @return {String}
   */
  async request (params, endpoint = 'search') {
    const response = await promisify(this.tracedRequest('Doofinder'))({
      uri: this.baseUri + endpoint,
      qs: { ...{ hashid: this.hashId }, ...params },
      headers: {
        Authorization: this.authKey
      },
      json: true
    })

    if (response.statusCode >= 400) {
      this.log.error(
        {
          body: response.body,
          request: params,
          endpoint
        },
        `Doofinder error code ${response.statusCode} in response`
      )
    }

    return response.body
  }

  /**
   * @param {String} query
   * @param {Object} filters
   * @param {Number} offset
   * @param {Number} limit
   * @param {Object} sort
   *
   * @return {{ results, totalProductCount }}
   */
  async paginatedRequest (query, filters, offset, limit, sort) {
    const rpp = limit < 100 ? limit : 100
    const firstPage = Math.floor(offset / rpp) + 1
    const lastPage = Math.ceil((offset + limit) / rpp)
    const skipCount = offset % rpp
    let results = []
    let totalProductCount = 0

    for (let currentPage = firstPage; currentPage <= lastPage; currentPage++) {
      const response = await this.request({ query, rpp, filter: filters, page: currentPage, sort })
      totalProductCount = response.total || 0

      if (!response.results || !Array.isArray(response.results)) {
        this.log.error(
          {
            response,
            request: { query, rpp, filter: filters, page: currentPage, sort }
          },
          'Doofinder empty results in response'
        )
      }
      // Force to array and filter empty items
      results = results.concat([].concat(response.results).filter(Boolean))
    }

    return {
      results: results.slice(skipCount, limit + skipCount),
      totalProductCount
    }
  }

  /**
   * @param {String} query
   *
   * @returns {Object}
   */
  async getSearchSuggestions (query) {
    const response = await this.request({ query: query.slice(0, 88) }, 'suggest')

    return {
      suggestions: response && response.results ? response.results.map(
        result => result.term.charAt(0).toUpperCase() + result.term.slice(1)
      ) : []
    }
  }

  /**
   * @param {Object} input
   * @return {Object}
   */
  async searchProducts ({ searchPhrase, filters, offset = 0, limit = 10, sort }) {
    const { results, totalProductCount } = await this.paginatedRequest(
      searchPhrase,
      this.prepareFilters(filters),
      offset,
      limit,
      this.prepareSort(sort)
    )

    return {
      productIds: results.map(result => {
        const productId = this.getProductId(result)
        if (!productId) {
          this.log.error({
            result,
            searchPhrase,
            filters,
            offset,
            limit,
            sort
          }, 'Doofinder empty result or product key for request')
          return null
        }
        return productId
      }).filter(Boolean),
      totalProductCount
    }
  }

  /**
   * @param {String} query
   *
   * @return {Object}
   */
  async getFilters (query) {
    const response = await this.request({ query })
    const filters = []

    for (const [key, value] of Object.entries(response.facets)) {
      if (['grouping_count'].includes(key)) { continue }
      if (value.terms && value.terms.buckets && !value.terms.buckets.length) { continue }
      filters.push({
        id: key,
        label: this.filterMap[key] ? this.filterMap[key] : key,
        source: 'doofinder',
        type: value.range ? 'range' : 'multiselect',
        minimum: value.range ? Math.floor(value.range.buckets[0].stats.min * 100) : undefined,
        maximum: value.range ? Math.ceil(value.range.buckets[0].stats.max * 100) : undefined,
        values: value.terms ? value.terms.buckets.map(element => ({
          id: element.key,
          label: element.key,
          hits: element.doc_count
        })) : undefined
      })
    }

    return { filters }
  }

  /**
   * @param {Object} filters
   *
   * @return {Object}
   */
  prepareFilters (filters = {}) {
    return Object.keys(filters).reduce((acc, filterKey) => {
      if (filterKey === 'price') {
        acc[filterKey] = {
          gte: filters[filterKey].minimum / 100,
          lt: filters[filterKey].maximum / 100
        }
      } else if (this.filterMapFlipped[filterKey]) {
        acc[this.filterMapFlipped[filterKey]] = filters[filterKey].values
      } else {
        acc[filterKey] = filters[filterKey].values
      }
      return acc
    }, {})
  }

  /**
   * @param {String} sort
   *
   * @return {Object}
   */
  prepareSort (sort) {
    return {
      price: sort === 'priceDesc' ? 'desc' : sort === 'priceAsc' ? 'asc' : undefined
    }
  }
}

module.exports = Client
