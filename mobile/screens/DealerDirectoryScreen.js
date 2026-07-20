import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, ScrollView, View, ActivityIndicator, RefreshControl } from 'react-native';
import { Search } from 'lucide-react-native';
import { api } from '../src/services/api';

export default function DealerDirectoryScreen({ onSelectDealer }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null); // No dealer is selected by default
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchDealers();
  }, []);

  const fetchDealers = async (query = '') => {
    setLoading(true);
    try {
      const response = await api.get('/dealers', {
        params: { search: query }
      });
      setDealers(response.data.dealers || []);
    } catch (error) {
      console.error('Error fetching dealers:', error);
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchDealers(searchQuery);
    setRefreshing(false);
  };

  // Debounce search
  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      fetchDealers(searchQuery);
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Dealer directory</Text>

      {/* Search Input */}
      <View style={styles.searchContainer}>
        <Search size={18} color="#8A8A8A" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search dealers"
          placeholderTextColor="#A0A0A0"
        />
      </View>

      {/* Dealer List */}
      <ScrollView 
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {loading && !refreshing && <ActivityIndicator size="small" color="#0082D1" style={{ marginTop: 20 }} />}
        {!loading && dealers.length === 0 && (
          <Text style={{ textAlign: 'center', color: '#8A8A8A', marginTop: 20 }}>No dealers found.</Text>
        )}
        {!loading && dealers.map(dealer => {
          const isSelected = dealer.id === selectedId;
          return (
            <TouchableOpacity
              key={dealer.id}
              style={[
                styles.dealerCard,
                isSelected && styles.dealerCardSelected
              ]}
              onPress={() => {
                if (isSelected) {
                  if (onSelectDealer) {
                    onSelectDealer(dealer, true);
                  }
                } else {
                  setSelectedId(dealer.id);
                  if (onSelectDealer) {
                    onSelectDealer(dealer, false);
                  }
                }
              }}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.dealerName}>{dealer.name}</Text>
                {isSelected && (
                  <View style={styles.selectedBadge}>
                    <Text style={styles.selectedBadgeText}>Selected</Text>
                  </View>
                )}
              </View>
              <Text style={styles.dealerAddress}>{dealer.address}</Text>
              
              {isSelected && (
                <View style={styles.actionPrompt}>
                  <Text style={styles.actionPromptText}>Tap again to check in</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  heading: {
    fontSize: 22,
    fontWeight: '500',
    color: '#434343',
    marginBottom: 16,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 0.5,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 20,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#434343',
  },
  listContainer: {
    paddingBottom: 24,
  },
  dealerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 0.5,
    borderColor: '#E0E0E0',
    marginBottom: 12,
  },
  dealerCardSelected: {
    borderColor: '#0082D1',
    backgroundColor: '#F2F9FD',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  dealerName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#434343',
    flex: 1,
  },
  dealerAddress: {
    fontSize: 13,
    color: '#8A8A8A',
  },
  selectedBadge: {
    backgroundColor: '#0082D1',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  selectedBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '500',
  },
  actionPrompt: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: '#D0E3F0',
    alignItems: 'flex-end',
  },
  actionPromptText: {
    fontSize: 12,
    color: '#0082D1',
    fontWeight: '500',
  },
});
